import { Router } from "express";
import crypto from "crypto";
import { HttpError } from "../utils/httpError";
import { SessionStore } from "../store/SessionStore";
import {
  signHostToken,
  toPublicSessionMetadata,
  validateCreateSessionBody,
  validateJoinBody,
  verifyHostToken
} from "../services/sessionCore";
import { getEnv } from "../utils/env";
import { createDailyMeetingToken, deleteDailyRoom, ensureDailyRoom } from "../services/daily";

const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_AI_USAGE_LIMIT = 10;

export function createSessionRouter(deps?: { store?: SessionStore }) {
  const router = Router();
  const store = deps?.store ?? new SessionStore();

  const getBearerToken = (authorizationHeader: unknown): string | undefined => {
    if (typeof authorizationHeader !== "string") return undefined;
    const [scheme, token] = authorizationHeader.split(" ");
    if (scheme !== "Bearer" || !token) return undefined;
    return token;
  };

  router.post("/api/session", (req, res, next) => {
    try {
      const env = getEnv();
      const jwtSecret = env.JWT_SECRET;
      if (!jwtSecret) {
        throw new HttpError(500, "JWT_SECRET is not configured");
      }

      const { type, scope, context } = validateCreateSessionBody(req.body);

      const session = store.create({
        type,
        scope,
        context,
        aiUsageLimit: DEFAULT_AI_USAGE_LIMIT,
        ttlMs: SESSION_TTL_MS
      });

      const hostToken = signHostToken({
        sessionId: session.id,
        expiresAt: session.expiresAt,
        jwtSecret
      });

      console.log(
        `Created session : sessionId: ${session.id}, joinUrl: /session/${session.id}, expiresAt: ${session.expiresAt}`
      );
        
      res.status(201).json({
        sessionId: session.id,
        expiresAt: session.expiresAt,
        hostToken
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Validation: invalid request";
      if (message.startsWith("Validation:")) {
        return next(new HttpError(400, message));
      }
      return next(err);
    }
  });

  router.get("/api/session/:id", (req, res, next) => {
    try {
      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      res.status(200).json(toPublicSessionMetadata(session));
    } catch (err) {
      return next(err);
    }
  });

  router.post("/api/session/:id/join", (req, res, next) => {
    (async () => {
      try {
      const env = getEnv();
      const jwtSecret = env.JWT_SECRET;
      if (!jwtSecret) {
        throw new HttpError(500, "JWT_SECRET is not configured");
      }

      if (!env.DAILY_DOMAIN || !env.DAILY_API_KEY) {
        throw new HttpError(500, "Daily is not configured (DAILY_DOMAIN/DAILY_API_KEY)");
      }

      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      const { role: requestedRole } = validateJoinBody(req.body);

      const bearer = getBearerToken(req.headers.authorization);
      const isHost = bearer
        ? verifyHostToken({ token: bearer, sessionId, jwtSecret })
        : false;

      const finalRole = isHost ? "host" : requestedRole;
      const roomName = `decisra-${sessionId}`;

      const expSeconds = Math.floor(session.expiresAt / 1000);
      await ensureDailyRoom({
        apiKey: env.DAILY_API_KEY,
        roomName,
        exp: expSeconds
      });

      const dailyToken = await createDailyMeetingToken({
        apiKey: env.DAILY_API_KEY,
        roomName,
        exp: expSeconds,
        isOwner: finalRole === "host",
        startAudioOff: finalRole === "observer",
        startVideoOff: true
      });

      const roomUrl = `${env.DAILY_DOMAIN.replace(/\/$/, "")}/${roomName}`;

      return res.status(200).json({
        role: finalRole,
        roomName,
        roomUrl,
        dailyToken
      });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Validation: invalid request";
        if (message.startsWith("Validation:")) {
          return next(new HttpError(400, message));
        }
        return next(err);
      }
    })();
  });

  // Link-join flow: user requests to join; host must admit.
  router.post("/api/session/:id/join-request", (req, res, next) => {
    try {
      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      const { role: requestedRole } = validateJoinBody(req.body);

      const requestId = crypto.randomBytes(12).toString("base64url");
      session.joinRequests.set(requestId, {
        id: requestId,
        requestedRole,
        status: "pending",
        createdAt: Date.now()
      });

      return res.status(201).json({ requestId, status: "pending" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Validation: invalid request";
      if (message.startsWith("Validation:")) {
        return next(new HttpError(400, message));
      }
      return next(err);
    }
  });

  router.get("/api/session/:id/join-request/:requestId", (req, res, next) => {
    try {
      const sessionId = req.params.id;
      const requestId = req.params.requestId;
      if (!sessionId || !requestId) {
        throw new HttpError(400, "Validation: session id and request id are required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      const joinRequest = session.joinRequests.get(requestId);
      if (!joinRequest) {
        throw new HttpError(404, "Join request not found");
      }

      // Only return token/url once admitted; keep it simple for frontend polling.
      return res.status(200).json({
        requestId: joinRequest.id,
        status: joinRequest.status,
        role: joinRequest.finalRole,
        roomUrl: joinRequest.roomUrl,
        dailyToken: joinRequest.dailyToken
      });
    } catch (err) {
      return next(err);
    }
  });

  // Host views pending requests
  router.get("/api/session/:id/join-requests", (req, res, next) => {
    try {
      const env = getEnv();
      const jwtSecret = env.JWT_SECRET;
      if (!jwtSecret) {
        throw new HttpError(500, "JWT_SECRET is not configured");
      }

      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      const bearer = getBearerToken(req.headers.authorization);
      if (!bearer || !verifyHostToken({ token: bearer, sessionId, jwtSecret })) {
        throw new HttpError(401, "Host token required");
      }

      const pending = Array.from(session.joinRequests.values())
        .filter((r) => r.status === "pending")
        .map((r) => ({
          requestId: r.id,
          requestedRole: r.requestedRole,
          createdAt: r.createdAt
        }));

      return res.status(200).json({ requests: pending });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/api/session/:id/join-requests/:requestId/admit", (req, res, next) => {
    (async () => {
      try {
        const env = getEnv();
        const jwtSecret = env.JWT_SECRET;
        if (!jwtSecret) {
          throw new HttpError(500, "JWT_SECRET is not configured");
        }

        if (!env.DAILY_DOMAIN || !env.DAILY_API_KEY) {
          throw new HttpError(500, "Daily is not configured (DAILY_DOMAIN/DAILY_API_KEY)");
        }

        const sessionId = req.params.id;
        const requestId = req.params.requestId;
        if (!sessionId || !requestId) {
          throw new HttpError(400, "Validation: session id and request id are required");
        }

        const session = store.get(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }

        if (store.isExpired(session)) {
          store.delete(sessionId);
          throw new HttpError(410, "Session expired");
        }

        const bearer = getBearerToken(req.headers.authorization);
        if (!bearer || !verifyHostToken({ token: bearer, sessionId, jwtSecret })) {
          throw new HttpError(401, "Host token required");
        }

        const joinRequest = session.joinRequests.get(requestId);
        if (!joinRequest) {
          throw new HttpError(404, "Join request not found");
        }
        if (joinRequest.status !== "pending") {
          throw new HttpError(409, "Join request already decided");
        }

        const finalRole = joinRequest.requestedRole;
        const roomName = `decisra-${sessionId}`;
        const expSeconds = Math.floor(session.expiresAt / 1000);

        await ensureDailyRoom({ apiKey: env.DAILY_API_KEY, roomName, exp: expSeconds });
        const dailyToken = await createDailyMeetingToken({
          apiKey: env.DAILY_API_KEY,
          roomName,
          exp: expSeconds,
          isOwner: false,
          startAudioOff: finalRole === "observer",
          startVideoOff: true
        });

        const roomUrl = `${env.DAILY_DOMAIN.replace(/\/$/, "")}/${roomName}`;
        joinRequest.status = "admitted";
        joinRequest.decidedAt = Date.now();
        joinRequest.finalRole = finalRole;
        joinRequest.roomUrl = roomUrl;
        joinRequest.dailyToken = dailyToken;

        return res.status(200).json({ ok: true });
      } catch (err) {
        return next(err);
      }
    })();
  });

  router.post("/api/session/:id/join-requests/:requestId/deny", (req, res, next) => {
    try {
      const env = getEnv();
      const jwtSecret = env.JWT_SECRET;
      if (!jwtSecret) {
        throw new HttpError(500, "JWT_SECRET is not configured");
      }

      const sessionId = req.params.id;
      const requestId = req.params.requestId;
      if (!sessionId || !requestId) {
        throw new HttpError(400, "Validation: session id and request id are required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      const bearer = getBearerToken(req.headers.authorization);
      if (!bearer || !verifyHostToken({ token: bearer, sessionId, jwtSecret })) {
        throw new HttpError(401, "Host token required");
      }

      const joinRequest = session.joinRequests.get(requestId);
      if (!joinRequest) {
        throw new HttpError(404, "Join request not found");
      }
      if (joinRequest.status !== "pending") {
        throw new HttpError(409, "Join request already decided");
      }

      joinRequest.status = "denied";
      joinRequest.decidedAt = Date.now();
      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/api/session/:id/end", (req, res, next) => {
    (async () => {
      try {
      const env = getEnv();
      const jwtSecret = env.JWT_SECRET;
      if (!jwtSecret) {
        throw new HttpError(500, "JWT_SECRET is not configured");
      }

      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      const bearer = getBearerToken(req.headers.authorization);
      if (!bearer || !verifyHostToken({ token: bearer, sessionId, jwtSecret })) {
        throw new HttpError(401, "Host token required");
      }

      store.delete(sessionId);

      // Best-effort: also delete the Daily room so active calls end.
      if (env.DAILY_API_KEY) {
        const roomName = `decisra-${sessionId}`;
        try {
          await deleteDailyRoom({ apiKey: env.DAILY_API_KEY, roomName });
        } catch {
          // ignore
        }
      }
      return res.status(200).json({ ok: true });
      } catch (err) {
        return next(err);
      }
    })();
  });

  router.post("/api/session/:id/ai", (req, res, next) => {
    try {
      const sessionId = req.params.id;
      if (!sessionId) {
        throw new HttpError(400, "Validation: session id is required");
      }

      const session = store.get(sessionId);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }

      if (store.isExpired(session)) {
        store.delete(sessionId);
        throw new HttpError(410, "Session expired");
      }

      if (session.type !== "verdict") {
        throw new HttpError(403, "AI is only available for verdict sessions");
      }

      const requestedRole =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>).role
          : undefined;
      if (requestedRole === "observer") {
        throw new HttpError(403, "Observers cannot use AI");
      }

      if (session.aiUsageCount >= session.aiUsageLimit) {
        throw new HttpError(429, "AI usage limit reached");
      }

      session.aiUsageCount += 1;
      return res.status(200).json({
        ok: true,
        aiUsageCount: session.aiUsageCount,
        aiUsageLimit: session.aiUsageLimit
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
