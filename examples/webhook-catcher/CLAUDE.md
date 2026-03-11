# webhook-catcher

A practical SPAWN example project that catches and logs incoming webhooks to a PostgreSQL database. Teaches DB integration with Express 5, pg, and auto-schema creation.

## What It Does

- **Catches any HTTP request** sent to the `/catch/*` endpoint and logs method, path, headers, query params, body, and source IP to PostgreSQL
- **Dashboard** at the root URL shows all captured webhooks in a live-updating dark-themed table
- **API** for listing, fetching, and clearing webhooks, plus stats

## Prerequisites

- PostgreSQL 16 with a database created for this project
- Node.js 20+

## Setup

```bash
# Create the database
sudo -u postgres createdb webhook_catcher_db -O scws

# Install dependencies
npm install

# Copy and edit .env
cp .env.example .env
# Edit .env with your DATABASE_URL, PORT, BASE_URL

# Build
npm run build

# Run
npm start
# Or for development:
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5050` | HTTP listen port |
| `BASE_URL` | (empty) | URL prefix (e.g., `/webhook-catcher`) |
| `DATABASE_URL` | `postgresql://scws:password@localhost:5432/webhook_catcher_db` | PostgreSQL connection string |

## API Endpoints

All paths are relative to `BASE_URL`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Dashboard UI |
| ANY | `/catch/*` | Catch-all webhook receiver (logs to DB) |
| GET | `/api/webhooks` | List webhooks (newest first, `?limit=N`, default 100) |
| GET | `/api/webhooks/:id` | Get single webhook by ID |
| DELETE | `/api/webhooks` | Clear all webhooks |
| GET | `/api/stats` | Stats: total, last24h, byMethod breakdown |

## Database

Auto-creates a `webhooks` table on startup:

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Auto-increment ID |
| `method` | TEXT | HTTP method (GET, POST, etc.) |
| `path` | TEXT | Request path after `/catch` |
| `headers` | JSONB | All request headers |
| `query` | JSONB | Query parameters |
| `body` | JSONB | Request body (truncated at 100KB) |
| `source_ip` | TEXT | Client IP address |
| `received_at` | TIMESTAMPTZ | Timestamp of receipt |

## PM2 Deployment (SPAWN Convention)

```bash
pm2 start dist/index.cjs --name webhook-catcher \
  --node-args="--max-old-space-size=128" \
  --max-memory-restart 150M
pm2 save
```

## Tech Stack

- Express 5, TypeScript 5.6, pg (node-postgres)
- esbuild for bundling to a single CJS file
- Self-contained dashboard (no external CSS/JS dependencies)
