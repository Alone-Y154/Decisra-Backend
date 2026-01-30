import type http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { getEnv } from "../utils/env";
import type { SessionStore } from "../store/SessionStore";
import { assertVerdictAiAllowed, buildVerdictInstructions } from "../services/aiRealtime";
import { checkPromptInScope } from "../services/openaiScopeGuard";
import { verifyAiAccessToken } from "../services/sessionCore";

type TrackedConnection = {
  client: WebSocket;
  upstream: WebSocket;
};

export function attachAiRealtimeProxy(input: {
  server: http.Server;
  store: SessionStore;
  onRegisterConnection?: (sessionId: string, conn: TrackedConnection) => void;
  onUnregisterConnection?: (sessionId: string, conn: TrackedConnection) => void;
}) {
  const wss = new WebSocketServer({ noServer: true });

  input.server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      const match = pathname.match(/^\/api\/session\/([^/]+)\/ai\/ws$/);
      if (!match) return;

      const sessionId = decodeURIComponent(match[1]);
      const requestedRole = url.searchParams.get("role");
      const token = url.searchParams.get("token");

      const env = getEnv();
      if (!env.JWT_SECRET) {
        socket.write(
          "HTTP/1.1 501 Not Implemented\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "JWT_SECRET is not configured"
        );
        socket.destroy();
        return;
      }

      if (!token) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "AI token required"
        );
        socket.destroy();
        return;
      }

      const aiAuth = verifyAiAccessToken({ token, sessionId, jwtSecret: env.JWT_SECRET });
      if (!aiAuth) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "Invalid AI token"
        );
        socket.destroy();
        return;
      }

      // Token is the source of truth for role; optionally sanity-check the query param.
      if (requestedRole && requestedRole !== aiAuth.role) {
        socket.write(
          "HTTP/1.1 400 Bad Request\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "Role mismatch"
        );
        socket.destroy();
        return;
      }

      const role = aiAuth.role;
      const clientKey = role === "host" ? "host" : `participant:${aiAuth.sub}`;

      // Validate before accepting.
      let session;
      try {
        ({ session } = assertVerdictAiAllowed({ store: input.store, sessionId, role }));
      } catch (err) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            (err instanceof Error ? err.message : "Forbidden")
        );
        socket.destroy();
        return;
      }

      if (!env.OPENAI_API_KEY) {
        socket.write(
          "HTTP/1.1 501 Not Implemented\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "OPENAI_API_KEY is not configured"
        );
        socket.destroy();
        return;
      }

      // Enforce per-client quota before accepting the WS.
      const currentUsage = session.aiUsageByClient.get(clientKey) ?? 0;
      if (currentUsage >= session.aiUsageLimit) {
        socket.write(
          "HTTP/1.1 429 Too Many Requests\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain\r\n\r\n" +
            "AI usage limit reached"
        );
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (client) => {
        const upstream = new WebSocket(env.OPENAI_REALTIME_URL, {
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            // Realtime API historically required this beta header; harmless if ignored.
            "OpenAI-Beta": "realtime=v1"
          }
        });

        // If the frontend sends messages immediately after the WS opens, the upstream connection
        // might not be open yet. Previously we dropped those messages (after scope-check!), which
        // looks like "no response". Buffer until upstream is ready.
        let upstreamReady = false;
        const pendingToUpstream: Array<{ data: any; isBinary?: boolean }> = [];

        const tracked: TrackedConnection = { client, upstream };
        input.onRegisterConnection?.(sessionId, tracked);

        const safeClose = () => {
          try {
            if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close();
          } catch {
            // ignore
          }
          try {
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
          } catch {
            // ignore
          }
        };

        upstream.on("open", () => {
          // Enforce scope/context by sending our own instructions.
          // We intentionally ignore any client-provided session.update.
          const instructions = buildVerdictInstructions(session);
          const payload = {
            type: "session.update",
            session: {
              instructions,
              // Force text output for Verdict AI.
              // This makes the model emit text deltas/events instead of audio.
              modalities: ["text"]
            }
          };
          try {
            upstream.send(JSON.stringify(payload));
          } catch {
            safeClose();
          }

          upstreamReady = true;

          // Let the client know upstream is ready (optional convenience event).
          try {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: "upstream.ready" }));

              // Also send an initial quota snapshot so UI can render counters immediately.
              const current = input.store.get(sessionId);
              const usage = current ? (current.aiUsageByClient.get(clientKey) ?? 0) : 0;
              const limit = current ? current.aiUsageLimit : session.aiUsageLimit;
              client.send(
                JSON.stringify({
                  type: "quota.snapshot",
                  aiUsageCount: usage,
                  aiUsageLimit: limit,
                  remaining: Math.max(0, limit - usage)
                })
              );
            }
          } catch {
            // ignore
          }

          // Flush anything queued while connecting.
          try {
            while (pendingToUpstream.length > 0 && upstream.readyState === WebSocket.OPEN) {
              const next = pendingToUpstream.shift();
              if (!next) break;
              if (next.isBinary) {
                upstream.send(next.data, { binary: true });
              } else {
                upstream.send(next.data);
              }
            }
          } catch {
            safeClose();
          }
        });

        upstream.on("message", (data, isBinary) => {
          // Pass through upstream events to client.
          // IMPORTANT: the `ws` library delivers text frames as Buffer by default; if we forward
          // the Buffer as-is, browser clients receive a Blob/ArrayBuffer instead of a string.
          // Convert non-binary frames to UTF-8 strings so frontends can JSON.parse(event.data).
          try {
            if (client.readyState !== WebSocket.OPEN) return;

            if (isBinary) {
              client.send(data, { binary: true });
              return;
            }

            const text = typeof data === "string" ? data : data.toString("utf8");
            client.send(text, { binary: false });
          } catch {
            safeClose();
          }
        });

        // Count usage on user messages and enforce limit.
        // Also validate each user prompt is within scope before forwarding.
        let guardChain: Promise<void> = Promise.resolve();
        let lastUserPromptBlocked = false;
        client.on("message", (raw) => {
          guardChain = guardChain
            .then(async () => {
              if (client.readyState !== WebSocket.OPEN) return;

            const text = typeof raw === "string" ? raw : raw.toString("utf8");
            const msg = JSON.parse(text) as any;

            // If the last user prompt was blocked, swallow a subsequent response.create so we
            // don't generate a reply based on stale context. Many clients always send
            // conversation.item.create -> response.create back-to-back.
            // IMPORTANT: do not emit an error here; some frontends treat any "error" event as
            // a terminal failure and disable AI.
            if (lastUserPromptBlocked && msg && msg.type === "response.create") {
              return;
            }

            // Block client attempts to override session instructions/tools.
            if (msg && msg.type === "session.update") {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: "error",
                    error: { message: "Client session.update is not allowed" }
                  })
                );
              }
              return;
            }

            // Usage accounting: treat each user conversation item as 1 usage.
            const isUserMessage =
              msg &&
              msg.type === "conversation.item.create" &&
              msg.item &&
              msg.item.role === "user";

            if (isUserMessage) {
              const current = input.store.get(sessionId);
              if (!current) {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: "error", error: { message: "Session not found" } }));
                }
                safeClose();
                return;
              }

              if (input.store.isExpired(current)) {
                input.store.delete(sessionId);
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: "error", error: { message: "Session expired" } }));
                }
                safeClose();
                return;
              }

              // Scope guard: reject out-of-scope prompts before spending quota.
              const userText =
                msg.item && Array.isArray(msg.item.content)
                  ? String(msg.item.content.map((c: any) => c?.text ?? "").join(" "))
                  : typeof msg.item?.text === "string"
                    ? msg.item.text
                    : "";

              const scopeResult = await checkPromptInScope({ session: current, userText });
              if (!scopeResult.inScope) {
                lastUserPromptBlocked = true;
                if (client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: "scope.violation",
                      message: "Prompt is outside the verdict scope",
                      reason: scopeResult.reason
                    })
                  );
                }
                return;
              }

              // In-scope user prompt; clear the block flag.
              lastUserPromptBlocked = false;

              const usage = current.aiUsageByClient.get(clientKey) ?? 0;
              if (usage >= current.aiUsageLimit) {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: "error", error: { message: "AI usage limit reached" } }));
                }
                safeClose();
                return;
              }

              const nextUsage = usage + 1;
              current.aiUsageByClient.set(clientKey, nextUsage);

              // Push a live quota update so the frontend doesn't need to refresh.
              try {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: "quota.update",
                      aiUsageCount: nextUsage,
                      aiUsageLimit: current.aiUsageLimit,
                      remaining: Math.max(0, current.aiUsageLimit - nextUsage)
                    })
                  );
                }
              } catch {
                // ignore quota UI updates
              }

              if (nextUsage >= current.aiUsageLimit) {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: "limit.reached",
                      remaining: 0,
                      aiUsageCount: nextUsage,
                      aiUsageLimit: current.aiUsageLimit
                    })
                  );
                }
                safeClose();
                return;
              }
            }

            // Forward client message upstream (or queue until upstream is open).
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(text);
            } else if (!upstreamReady) {
              pendingToUpstream.push({ data: text, isBinary: false });
            }
            })
            .catch(() => {
              // If parsing fails, just forward raw as-is.
              try {
                if (upstream.readyState === WebSocket.OPEN) {
                  upstream.send(raw as any);
                } else if (!upstreamReady) {
                  pendingToUpstream.push({ data: raw as any });
                }
              } catch {
                safeClose();
              }
            });
        });

        const onClose = () => {
          input.onUnregisterConnection?.(sessionId, tracked);
          safeClose();
        };

        client.on("close", onClose);
        upstream.on("close", onClose);
        client.on("error", onClose);
        upstream.on("error", onClose);
      });
    } catch {
      socket.destroy();
    }
  });
}
