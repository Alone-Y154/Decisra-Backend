import express from "express";
import cors from "cors";
import { getEnv } from "./utils/env";
import { healthRouter } from "./routes/health";
import { createSessionRouter } from "./routes/session";
import { notFoundHandler } from "./middleware/notFound";
import { errorHandler } from "./middleware/errorHandler";

const env = getEnv();

const app = express();

// Trust proxy (useful behind load balancers / reverse proxies)
if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

// Core middleware
app.use(express.json());

// CORS
app.use(
  cors({
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
    credentials: true
  })
);

// Routes
app.use(healthRouter);
app.use(createSessionRouter());

// 404 + error handling
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${env.PORT}`);
});
