import crypto from "crypto";

export type SessionType = "normal" | "verdict";

export type JoinRoleIntent = "participant" | "observer";

export type JoinRequestStatus = "pending" | "admitted" | "denied";

export type JoinRequest = {
  id: string;
  requestedRole: JoinRoleIntent;
  status: JoinRequestStatus;
  createdAt: number;
  decidedAt?: number;
  // Populated once admitted
  roomUrl?: string;
  dailyToken?: string;
  finalRole?: "participant" | "observer";
};

export type Session = {
  id: string;
  type: SessionType;
  scope?: string;
  context?: string;
  createdAt: number;
  expiresAt: number;
  aiUsageCount: number;
  aiUsageLimit: number;
  joinRequests: Map<string, JoinRequest>;
};

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(input: {
    type: SessionType;
    scope?: string;
    context?: string;
    aiUsageLimit: number;
    ttlMs: number;
    now?: number;
  }): Session {
    const now = input.now ?? Date.now();
    const id = crypto.randomBytes(16).toString("base64url");

    const session: Session = {
      id,
      type: input.type,
      scope: input.scope,
      context: input.context,
      createdAt: now,
      expiresAt: now + input.ttlMs,
      aiUsageCount: 0,
      aiUsageLimit: input.aiUsageLimit,
      joinRequests: new Map()
    };

    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  isExpired(session: Session, now: number = Date.now()): boolean {
    return now > session.expiresAt;
  }
}
