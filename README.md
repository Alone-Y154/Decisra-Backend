# Decisra Server (Backend)

This folder contains the Decisra backend API.

At a high level, the backend is responsible for **truth + enforcement**:
- **Does a session exist?**
- **Is it still active (not expired)?**
- **What session type is it (normal vs verdict)?**
- **Who is host vs participant/observer?**
- **How do we issue role-aware audio tokens (Daily)?**

The frontend expresses intent (join, role choice, UI navigation). The backend decides what is true.

## What We’re Building

### 1) Session Core (Source of Truth)
A Session is a short-lived object stored server-side:
- Random, unguessable `id`
- `type`: `normal | verdict`
- `scope` (required for verdict)
- `context` (optional)
- `createdAt` and absolute `expiresAt`
- AI usage counters (`aiUsageCount`, `aiUsageLimit`)

Sessions are currently stored **in-memory** (a Map) via a `SessionStore` abstraction.
That keeps Phase 1 fast and deterministic, and makes it easy to swap in Redis later.

### 2) Host Authority (JWT)
When a session is created, the backend issues a `hostToken` (a JWT).
- Only the backend can sign valid host tokens (it uses `JWT_SECRET`).
- The backend verifies this token to authorize **host-only** actions.

### 3) Link Join + Host Admits
When someone joins using a link, they do not immediately receive call access.
Instead, they create a **join request**, and the host can admit/deny it.

### 4) Daily (Audio)
Daily is used for audio rooms/tokens.
The backend:
- Ensures a Daily room exists per session (`decisra-<sessionId>`)
- Mints role-aware Daily meeting tokens
- Deletes the Daily room on session end (best-effort)

## Folder Structure

```
src/
 ├─ routes/        # Express routes (/api/session, join requests, etc.)
 ├─ services/      # Session helpers + Daily API integration
 ├─ middleware/    # Error handling, 404 handler
 ├─ store/         # SessionStore (in-memory Map) + session types
 ├─ utils/         # env loading, HttpError
 └─ server.ts      # Express app bootstrap
```

## Environment Variables

This project uses `dotenv` and reads `.env`.
An example template exists in `.env.example`.

Required / important:
- `PORT` — backend port (default in code is 4000; your `.env` can override)
- `CORS_ORIGINS` — comma-separated origins allowed to call the API (e.g. `http://localhost:3001`)
- `JWT_SECRET` — secret used to sign/verify `hostToken`
- `DAILY_DOMAIN` — e.g. `https://decisra.daily.co`
- `DAILY_API_KEY` — Daily REST API key (backend-only; do not expose)

## Running Locally

Install deps:
- `npm install`

Dev mode:
- `npm run dev`

Build + run:
- `npm run build`
- `npm run start`

Health check:
- `GET http://localhost:<PORT>/health`

## Docker

### Build + run (Docker)
- Build: `docker build -t decisra-backend .`
- Run: `docker run --rm -p 4000:4000 --env-file .env decisra-backend`

### Run (docker-compose)
- Start: `docker compose up --build`
- Stop: `docker compose down`

Notes:
- The backend reads config from environment variables (see `.env.example`).
- SSE endpoints are supported in Docker as-is; if you put a reverse proxy in front (nginx, etc.), ensure response buffering is disabled for `text/event-stream`.

## API Overview

### Health
- `GET /health` → `{ "status": "ok" }`

### Sessions
- `POST /api/session`
  - Request:
    - `{ "type": "normal" }`
    - or `{ "type": "verdict", "scope": "...", "context": "..." }`
  - Response: `{ sessionId, expiresAt, hostToken }`

- `GET /api/session/:id`
  - `404` if never existed
  - `410` if existed but expired
  - `200` with public metadata otherwise

### Host Join (host-only)
- `POST /api/session/:id/join`
  - Header: `Authorization: Bearer <hostToken>`
  - Response: `{ role, roomName, roomUrl, dailyToken }`

### Link Join + Host Admits
- `POST /api/session/:id/join-request`
  - Body: `{ "role": "participant" | "observer" }`
  - Response: `{ requestId, status: "pending" }`

- `GET /api/session/:id/join-request/:requestId/stream` (SSE)
  - Used by joiners to subscribe for updates (no polling)
  - Emits `event: status` with `{ requestId, status, role, roomUrl, dailyToken }`
  - Stream ends automatically once `admitted` or `denied`

- `GET /api/session/:id/join-requests/stream` (SSE, host-only)
  - Header: `Authorization: Bearer <hostToken>`
  - Emits `event: requests` with `{ sessionId, requests: [{ requestId, requestedRole, createdAt }] }`
  - Used by host UI to receive pending join request updates without polling

- `POST /api/session/:id/join-requests/:requestId/admit` (host-only)
  - Header: `Authorization: Bearer <hostToken>`
  - Admits the request and attaches Daily credentials for the joiner

- `POST /api/session/:id/join-requests/:requestId/deny` (host-only)
  - Header: `Authorization: Bearer <hostToken>`

### Host End Call
- `POST /api/session/:id/end` (host-only)
  - Header: `Authorization: Bearer <hostToken>`
  - Deletes the session from the in-memory store and attempts to delete the Daily room

### AI (verdict sessions only)
- `POST /api/session/:id/ai`
  - Enforces:
    - session must be active
    - session type must be `verdict`
    - observer cannot use AI
    - `aiUsageCount < aiUsageLimit`

## Notes / Phase 1 Constraints

- Sessions and join requests are stored in memory.
  - Restarting the backend clears them.
- Daily tokens are minted by the backend and returned to clients only when needed.
- Host authority is based on a signed JWT (`hostToken`).
