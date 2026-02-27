# CLAUDE.md — SCWS (Self Coding Web Server)

## Project Overview

SCWS is a self-hosted development + hosting server. A Vultr VPS (8GB/4vCPU, Ubuntu 24.04) that is simultaneously a dev environment, web server, database host, and Claude CLI workspace. A control daemon manages project lifecycle, and projects are previewed at `scws.duckdns.org/<project-name>`.

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript 5.6
- **Framework**: Express 5 (daemon API + dashboard)
- **Database**: PostgreSQL 16 + Drizzle ORM (schema push workflow)
- **Build**: esbuild → `dist/index.cjs` + `dist/dashboard.html`
- **Frontend**: Single-file SPA (`dashboard.html`) — all CSS, HTML, JS inline
- **Auth**: Bearer token (timing-safe compare), `DASHBOARD_TOKEN` env var
- **Process Manager**: PM2
- **Reverse Proxy**: nginx + Let's Encrypt SSL
- **Domain**: `scws.duckdns.org` (DuckDNS)
- **AI**: Claude CLI (headless mode, connected to MCP server at passoncloud.duckdns.org)

## Project Structure

```
SCWS/
├── shared/schema.ts          — Drizzle schema (projects, claude_runs, activity_log, daemon_config)
├── daemon/
│   ├── index.ts              — Express app, REST routes, auth, dashboard serving
│   ├── storage.ts            — IStorage + DatabaseStorage (all DB queries)
│   ├── db.ts                 — pg Pool + Drizzle instance
│   ├── logger.ts             — log() helper
│   ├── asyncHandler.ts       — Express error wrapper
│   ├── projects.ts           — Project lifecycle (create, start, stop, build, delete)
│   ├── nginx.ts              — nginx config generation + reload
│   ├── pm2.ts                — PM2 process management
│   ├── claude.ts             — Claude CLI headless wrapper
│   ├── github.ts             — gh CLI operations
│   ├── deploy.ts             — Build + SCP to production servers
│   └── dashboard.html        — Single-file SPA control panel
├── scripts/
│   ├── bootstrap.sh          — Full VPS provisioning
│   ├── healthcheck.sh        — Cron health monitor
│   └── duckdns-update.sh     — DuckDNS IP updater
├── templates/
│   ├── nginx-project.conf    — Per-project nginx location block
│   └── env.template          — Per-project .env template
└── script/build.ts           — esbuild bundler
```

**On VPS** (`/var/www/scws/`):
- `daemon/dist/` — built daemon bundle
- `projects/` — hosted projects (created dynamically)
- `nginx/projects/` — generated per-project nginx configs
- `.env` — DATABASE_URL, PORT, DASHBOARD_TOKEN

## Code Style & Conventions

- TypeScript: `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Express routes wrapped with `asyncHandler()`
- DB queries through `storage.*` methods — never use `db` directly in routes
- All shell commands via `child_process.execFile` (not `exec`) for safety
- Dashboard: vanilla JS, no framework, uses `api()` helper for fetch with auth

## Commands

- **Dev**: `npm run dev` (tsx, hot reload)
- **Build**: `npm run build` → `dist/index.cjs` + `dist/dashboard.html`
- **Deploy**: `scp dist/* root@<VPS_IP>:/var/www/scws/daemon/dist/` then `ssh root@<VPS_IP> 'pm2 restart scws-daemon'`
- **Type check**: `npx tsc --noEmit`

## Database Tables

| Table | Purpose |
|-------|---------|
| `projects` | Project registry (name, port, status, framework, git, deploy targets) |
| `claude_runs` | Claude CLI execution log (prompt, output, mode, session) |
| `activity_log` | All actions (created, built, deployed, etc.) |
| `daemon_config` | Key-value settings |

## Port Allocation

- 4000: SCWS daemon (fixed)
- 5001–5099: Hosted projects (auto-assigned)
