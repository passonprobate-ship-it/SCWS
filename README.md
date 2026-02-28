# SPAWN — Self-Programming Autonomous Web Node

A self-programming daemon running on a Raspberry Pi 5 that creates, builds, deploys, and manages web projects autonomously via Claude CLI. It provides a web dashboard for project management, real-time terminal access, Claude AI integration, and notification channels.

## Architecture

```
                    Tailscale VPN (100.89.2.95)
                           │
                      ┌────┴────┐
                      │  nginx  │  :80
                      └────┬────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
         ┌────┴────┐  ┌───┴───┐      ┌─────┴─────┐
         │ Daemon  │  │Project│ ...  │  Project   │
         │  :4000  │  │ :5001 │      │   :5099    │
         └────┬────┘  └───────┘      └───────────┘
              │
     ┌────────┼────────┐
     │        │        │
  ┌──┴──┐ ┌──┴──┐ ┌───┴───┐
  │ DB  │ │ PM2 │ │Claude │
  │     │ │     │ │  CLI  │
  └─────┘ └─────┘ └───────┘
```

- **Daemon** (Express 5, port 4000) — REST API + web dashboard + WebSocket terminal
- **Projects** (ports 5001–5099) — Managed by PM2, auto-configured nginx routing
- **Database** — PostgreSQL 16, Drizzle ORM, 6 tables
- **Claude CLI** — Headless mode, SSE streaming, session continuity
- **Notifications** — Telegram + Email (AgentMail) via notification channels

## Quick Reference

| Action | Command |
|--------|---------|
| Dev server | `npm run dev` |
| Build | `npx tsx script/build.ts` |
| Type check | `npx tsc --noEmit` |
| Deploy to Pi | `scp dist/* codeman@100.89.2.95:/var/www/scws/daemon/dist/` |
| Restart daemon | `ssh codeman@100.89.2.95 'pm2 restart scws-daemon'` |
| View logs | `ssh codeman@100.89.2.95 'pm2 logs scws-daemon --lines 30'` |
| Health check | `curl http://100.89.2.95/health` |
| DB shell | `ssh codeman@100.89.2.95 'psql -U scws scws_daemon'` |

## Tech Stack

Express 5 · TypeScript 5.6 · Drizzle ORM · PostgreSQL 16 · esbuild · PM2 · nginx · node-pty · WebSocket · Tailscale

## Project Structure

```
SCWS/
├── shared/
│   └── schema.ts            Drizzle ORM schema (6 tables, Zod schemas, types)
├── daemon/
│   ├── index.ts             Express app — all REST routes + middleware (790 lines)
│   ├── storage.ts           IStorage interface + DatabaseStorage (all DB queries)
│   ├── db.ts                pg Pool + Drizzle instance
│   ├── logger.ts            Shared log() helper
│   ├── asyncHandler.ts      Express async error handler wrapper
│   ├── projects.ts          Project lifecycle (create, scaffold, start, stop, build, delete)
│   ├── claude.ts            Claude CLI runner (headless, SSE streaming, sessions)
│   ├── channels.ts          Notification channels (Telegram, Email, rules, dispatcher)
│   ├── terminal.ts          Web terminal (xterm.js + node-pty + WebSocket)
│   ├── mcp.ts               MCP server config management (settings.json I/O)
│   ├── github.ts            GitHub CLI wrapper (init, clone, push, pull)
│   ├── deploy.ts            Build + SCP deployment to remote servers
│   ├── nginx.ts             nginx config generation + reload
│   ├── pm2.ts               PM2 process management wrapper
│   └── dashboard.html       Single-file SPA (CSS + HTML + JS, ~3500 lines)
├── script/
│   └── build.ts             esbuild bundler → dist/index.cjs + dist/dashboard.html
├── scripts/
│   ├── bootstrap.sh         Fresh Pi provisioning (15 steps)
│   ├── healthcheck.sh       Cron health monitor (services, disk, memory)
│   └── duckdns-update.sh    Dynamic DNS updater
├── templates/
│   ├── env.template         .env file template
│   └── nginx-project.conf   Per-project nginx config template
├── docs/                    Documentation
│   ├── setup.md             Developer setup + provisioning guide
│   ├── api.md               REST API reference (46 endpoints)
│   └── operations.md        Operations runbook
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── CLAUDE.md                AI autonomy instructions (for Claude sessions on Pi)
```

## Dashboard

The web dashboard at `http://100.89.2.95` provides:

| Page | Shortcut | Description |
|------|----------|-------------|
| Terminal | `Ctrl+J` | Full PTY terminal (xterm.js + node-pty) |
| Projects | `Ctrl+1` | Project cards — start/stop/build/deploy, Claude runs, logs |
| System | `Ctrl+2` | Disk, memory, PM2 processes, daemon uptime |
| Activity | `Ctrl+3` | Chronological action log |
| MCP | `Ctrl+4` | Claude MCP server management (add/edit/test/delete) |
| Channels | `Ctrl+5` | Notification channels (Telegram/Email setup, rules, log) |
| Cortex | `Ctrl+6` | System monitoring, cron scheduler, webhooks (iframe embed) |

Additional shortcuts: `Ctrl+K` command palette, `Ctrl+N` new project, `Ctrl+I` import from URL.

## Documentation

- **[Setup Guide](docs/setup.md)** — Local development, environment variables, database, Pi provisioning
- **[API Reference](docs/api.md)** — All 46 REST endpoints with params and responses
- **[Operations Runbook](docs/operations.md)** — Deploy, monitor, troubleshoot, backup

## Hosted Projects

| Project | Port | Description |
|---------|------|-------------|
| artsys | 5001 | Art inventory management system |
| spawn-cortex | 5002 | System monitoring + cron scheduling + webhooks |
| gpio-toolkit | 5010 | GPIO REST API for Pi hardware control |

## License

Private project.
