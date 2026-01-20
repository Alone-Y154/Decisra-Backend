import jwt from "jsonwebtoken";
import type { JoinRoleIntent, Session, SessionType } from "../store/SessionStore";

export function signHostToken(input: {
  sessionId: string;
  expiresAt: number;
  jwtSecret: string;
}): string {
  const nowMs = Date.now();
  const ttlSeconds = Math.max(1, Math.floor((input.expiresAt - nowMs) / 1000));

  return jwt.sign(
    {
      sessionId: input.sessionId,
      role: "host"
    },
    input.jwtSecret,
    {
      expiresIn: ttlSeconds
    }
  );
}

export function verifyHostToken(input: {
  token: string;
  sessionId: string;
  jwtSecret: string;
}): boolean {
  const decoded = jwt.verify(input.token, input.jwtSecret) as unknown;

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return false;

  const payload = decoded as Record<string, unknown>;
  return payload.role === "host" && payload.sessionId === input.sessionId;
}

export function validateCreateSessionBody(body: unknown): {
  type: SessionType;
  scope?: string;
  context?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Validation: body must be an object");
  }

  const record = body as Record<string, unknown>;
  const allowedKeys = new Set(["type", "scope", "context"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Validation: unknown field '${key}'`);
    }
  }

  const type = record.type;
  if (type !== "normal" && type !== "verdict") {
    throw new Error("Validation: type must be 'normal' or 'verdict'");
  }

  const scope = record.scope;
  const context = record.context;

  if (type === "verdict") {
    if (typeof scope !== "string" || scope.trim().length === 0) {
      throw new Error("Validation: scope is required for verdict sessions");
    }
  } else {
    if (scope !== undefined) {
      throw new Error("Validation: scope is not allowed for normal sessions");
    }
  }

  if (context !== undefined && typeof context !== "string") {
    throw new Error("Validation: context must be a string");
  }

  return {
    type,
    scope: typeof scope === "string" ? scope : undefined,
    context: typeof context === "string" ? context : undefined
  };
}

export function validateJoinBody(body: unknown): { role: JoinRoleIntent } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Validation: body must be an object");
  }

  const record = body as Record<string, unknown>;
  const allowedKeys = new Set(["role"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Validation: unknown field '${key}'`);
    }
  }

  const role = record.role;
  if (role !== "participant" && role !== "observer") {
    throw new Error("Validation: role must be 'participant' or 'observer'");
  }

  return { role };
}

export function toPublicSessionMetadata(session: Session) {
  return {
    id: session.id,
    type: session.type,
    scope: session.scope,
    context: session.context,
    expiresAt: session.expiresAt
  };
}
