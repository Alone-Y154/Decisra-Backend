import { Router } from "express";
import { HttpError } from "../utils/httpError";
import type { SessionStore } from "../store/SessionStore";
import { assertVerdictAiAllowed } from "../services/aiRealtime";
import { getEnv } from "../utils/env";
import { signAiAccessToken, verifyHostToken } from "../services/sessionCore";

function getBearerToken(authorizationHeader: unknown): string | undefined {
  if (typeof authorizationHeader !== "string") return undefined;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) return undefined;
  return token;
}

export function createAiRouter(deps: { store: SessionStore }) {
  const router = Router();

  // Preflight endpoint used by the frontend before opening the realtime WS.
  // Returns the WS path, an aiToken (required for WS), and remaining quota for that AI client.
  router.post("/api/session/:id/ai/connect", (req, res, next) => {
    try {
      const env = getEnv();
      if (!env.JWT_SECRET) {
        throw new HttpError(500, "JWT_SECRET is not configured");
      }

      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : undefined;
      const role = body ? body.role : undefined;
      const requestId = body ? body.requestId : undefined;

      let session;
      try {
        ({ session } = assertVerdictAiAllowed({ store: deps.store, sessionId, role }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI not available";
        if (msg === "Session not found") return next(new HttpError(404, msg));
        if (msg === "Session expired") return next(new HttpError(410, msg));
        if (msg === "AI is only available for verdict sessions") return next(new HttpError(403, msg));
        if (msg === "Invalid role") return next(new HttpError(400, "Validation: role must be 'host' or 'participant'"));
        return next(new HttpError(403, msg));
      }

      const wsPath = `/api/session/${encodeURIComponent(sessionId)}/ai/ws`;

      // Determine the AI client identity and mint an access token.
      let subject: string;
      if (role === "host") {
        const bearer = getBearerToken(req.headers.authorization);
        if (!bearer || !verifyHostToken({ token: bearer, sessionId, jwtSecret: env.JWT_SECRET })) {
          return next(new HttpError(401, "Host token required"));
        }
        subject = "host";
      } else {
        // role === "participant"
        if (typeof requestId !== "string" || requestId.trim().length === 0) {
          return next(new HttpError(400, "Validation: requestId is required for participant AI"));
        }

        const jr = session.joinRequests.get(requestId);
        if (!jr) return next(new HttpError(404, "Join request not found"));
        if (jr.status !== "admitted") return next(new HttpError(403, "Join request not admitted"));
        if (jr.finalRole !== "participant") return next(new HttpError(403, "Observers cannot use AI"));
        subject = requestId;
      }

      const clientKey = role === "host" ? "host" : `participant:${subject}`;
      const aiUsageCount = session.aiUsageByClient.get(clientKey) ?? 0;
      const aiUsageLimit = session.aiUsageLimit;
      const remaining = Math.max(0, aiUsageLimit - aiUsageCount);

      if (remaining <= 0) {
        return next(new HttpError(429, "AI usage limit reached"));
      }

      const aiToken = signAiAccessToken({
        sessionId,
        role: role as any,
        subject,
        expiresAt: session.expiresAt,
        jwtSecret: env.JWT_SECRET
      });

      return res.status(200).json({
        ok: true,
        wsPath,
        aiToken,
        expiresAt: session.expiresAt,
        aiUsageCount,
        aiUsageLimit,
        remaining
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
