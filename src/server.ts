import express from "express";
import http from "http";
import cors, { type CorsOptions } from "cors";
import { getEnv } from "./utils/env";
import { healthRouter } from "./routes/health";
import { createSessionRouter } from "./routes/session";
import { notFoundHandler } from "./middleware/notFound";
import { errorHandler } from "./middleware/errorHandler";
import { SessionStore } from "./store/SessionStore";
import { deleteDailyRoom } from "./services/daily";
import { createAiRouter } from "./routes/ai";
import { createContactRouter } from "./routes/contact";
import { attachAiRealtimeProxy } from "./ws/aiRealtimeProxy";

const env = getEnv();

const store = new SessionStore();

// Track AI websocket connections so we can force-close them on expiry.
const aiConnectionsBySessionId = new Map<
  string,
  Set<{ client: import("ws").WebSocket; upstream: import("ws").WebSocket }>
>();

// Ensure sessions expire even if no one calls the API.
// Best-effort also deletes the Daily room so active calls end.
const SESSION_CLEANUP_INTERVAL_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const session of store.values()) {
    if (!store.isExpired(session, now)) continue;

    store.delete(session.id);

    const conns = aiConnectionsBySessionId.get(session.id);
    if (conns && conns.size > 0) {
      for (const c of conns) {
        try {
          c.client.close(4000, "Session expired");
        } catch {
          // ignore
        }
        try {
          c.upstream.close();
        } catch {
          // ignore
        }
      }
      aiConnectionsBySessionId.delete(session.id);
    }

    if (env.DAILY_API_KEY) {
      const roomName = `decisra-${session.id}`;
      void deleteDailyRoom({ apiKey: env.DAILY_API_KEY, roomName }).catch(() => {
        // ignore
      });
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);

const app = express();
const server = http.createServer(app);

// Trust proxy (useful behind load balancers / reverse proxies)
if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

// Core middleware
app.use(express.json());

// CORS
const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser tools (curl, Postman) with no Origin header
    if (!origin) return callback(null, true);

    if (env.CORS_ORIGINS.length === 0) {
      // Default permissive behavior if not configured
      return callback(null, true);
    }

    if (env.CORS_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  // Make preflights explicit and predictable.
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
};

// Preflight handler (Express 5 doesn't support "*"; use a regex to match all paths)
app.options(/.*/, cors(corsOptions));

app.use(cors(corsOptions));

// Routes
app.use(healthRouter);
app.use(createSessionRouter({ store }));
app.use(createAiRouter({ store }));
app.use(createContactRouter());

// 404 + error handling
app.use(notFoundHandler);
app.use(errorHandler);

attachAiRealtimeProxy({
  server,
  store,
  onRegisterConnection: (sessionId, conn) => {
    let set = aiConnectionsBySessionId.get(sessionId);
    if (!set) {
      set = new Set();
      aiConnectionsBySessionId.set(sessionId, set);
    }
    set.add(conn);
  },
  onUnregisterConnection: (sessionId, conn) => {
    const set = aiConnectionsBySessionId.get(sessionId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) aiConnectionsBySessionId.delete(sessionId);
  }
});

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${env.PORT}`);
});
