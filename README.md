# SPAWN — Self-Programming Autonomous Web Node

A self-programming autonomous web node running on a Raspberry Pi 5. Uses Claude AI to autonomously create, build, deploy, and manage web projects — writing code, installing dependencies, configuring databases, setting up reverse proxies, and starting processes without manual intervention.

## Architecture

```
/var/www/scws/
├── daemon/                   ← Control plane (Express 5, port 4000)
│   ├── dist/index.cjs        ← Built daemon bundle
│   ├── dist/dashboard.html   ← Web dashboard SPA (single-file, ~5400 lines)
│   ├── .env                  ← DATABASE_URL, DASHBOARD_TOKEN, etc.
│   ├── ecosystem.config.cjs  ← PM2 config with heap caps
│   ├── package.json
│   └── package-lock.json
├── projects/                 ← Hosted projects (each self-contained)
│   ├── gpio-toolkit/         ← Pi 5 GPIO REST API (port 5010)
│   ├── spawn-cortex/         ← Scheduler + webhooks (port 5002)
│   ├── spawn-landing/        ← Landing page (port 5003)
│   ├── galleria/             ← Image gallery (port 5011)
│   ├── solbot/               ← Solana trading bot (port 5012)
│   └── spawn-mcp/            ← Local MCP server (port 5020)
├── nginx/projects/           ← Auto-generated per-project nginx configs
├── scripts/
│   ├── bootstrap.sh          ← Full system bootstrap (28 sections)
│   ├── backup-db.sh          ← Nightly local DB backup
│   ├── backup-offsite.sh     ← Nightly off-site backup (12 types)
│   ├── set-oom-scores.sh     ← OOM killer prioritization
│   ├── git-post-commit       ← Git hook for activity tracking
│   └── git-pre-push          ← Git hook for pre-push checks
├── backups/                  ← Local backup rotation (7 days)
├── logs/
├── CLAUDE.md                 ← AI instructions (loaded every session)
└── README.md                 ← This file
```

## Dashboard

The web dashboard is a single-file SPA at `http://<host>:4000/` (or via nginx at the root). It provides full control over the SPAWN system.

### Pages

| Page | Shortcut | Description |
|------|----------|-------------|
| Terminal | `Ctrl+J` | Interactive Claude AI terminal — run prompts and let Claude work autonomously |
| Sessions | — | View and resume previous Claude AI sessions with full history |
| Projects | `Ctrl+1` | Project dashboard — create, start, stop, build, deploy, view logs |
| System | `Ctrl+2` | System health — CPU, memory, disk, temperature, PM2 process status |
| Activity | `Ctrl+3` | Timeline of all actions — creates, builds, deploys, starts, stops |
| MCP | `Ctrl+4` | MCP server status and persistent memory management |
| Channels | `Ctrl+5` | Notification channels — email, webhook, and alert configuration |
| Cortex | `Ctrl+6` | Scheduler, cron jobs, and webhook ingress endpoints |
| Files | `Ctrl+7` | Server filesystem browser — navigate, view, edit, upload, download |
| Connections | `Ctrl+8` | External service connections — GitHub, APIs, linked accounts |
| VPS | `Ctrl+9` | VPS deploy targets — manage remote servers for project deployment |
| Funnel | — | Analytics and conversion funnel tracking |
| Help | `?` | In-dashboard help center — pages reference, shortcuts, quick tips |

### Additional Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open command palette |
| `Esc` | Close modal or command palette |

## Tech Stack

- **Hardware**: Raspberry Pi 5, 8GB RAM, Ubuntu Server 24.04 ARM64
- **Runtime**: Node.js 20+ / TypeScript 5.6
- **Daemon**: Express 5 on port 4000
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Build**: esbuild → single CJS bundle + dashboard HTML
- **Process Manager**: PM2 with pm2-logrotate
- **Reverse Proxy**: nginx (HTTP, Tailscale VPN encrypts the wire)
- **Frontend**: Single-file SPA — vanilla JS, no framework
- **Auth**: Bearer token with timing-safe compare
- **AI**: Claude Code CLI (headless sessions)
- **VCS**: Git + GitHub CLI (`gh`)

## Database

PostgreSQL user `scws`, database `scws_daemon`.

| Table | Purpose |
|-------|---------|
| `projects` | Project registry (name, port, status, framework, git, deploy targets) |
| `claude_runs` | Claude session history (prompt, output, mode, session, duration) |
| `activity_log` | All system actions (created, built, deployed, started, stopped) |
| `daemon_config` | Key-value daemon settings |
| `spawn_memories` | Persistent key-value memory for MCP server |

Additional per-project databases are created on demand (e.g., `spawn_cortex`, `solbot_db`).

## Port Map

| Port | Service |
|------|---------|
| 4000 | SPAWN daemon (fixed) |
| 5002 | spawn-cortex |
| 5003 | spawn-landing |
| 5010 | gpio-toolkit |
| 5011 | galleria |
| 5012 | solbot |
| 5020 | spawn-mcp |

Project ports are auto-assigned from the 5001–5099 range.

## Memory Management

Defense-in-depth memory management across 3 layers:

**System tuning**: `vm.swappiness=5`, `vm.vfs_cache_pressure=50`, 4GB swap, Docker disabled at boot.

**PM2 heap caps**: Each process has `--max-old-space-size` and `max_memory_restart` limits (64–256 MB heap depending on process).

**Watchdog**: Tiered memory watchdog in the daemon — 70% warn, 85% auto-stop idle projects, 93% emergency stop + drop caches. Memory snapshots logged every 10 minutes.

**OOM killer**: Custom OOM scores via systemd drop-in — PM2 god daemon protected (-800), daemon protected (-500), projects expendable (+300).

## Network Access

Accessible via Tailscale VPN only. No public internet exposure.

- **Tailscale IP**: `100.89.2.95`
- **Tailscale DNS**: `spawn.tail852587.ts.net`

## Backups

- **Local**: Nightly at 2:00 AM CST, 7-day rotation → `/var/www/scws/backups/`
- **Off-site**: Nightly at 2:15 AM CST → `passoncloud.duckdns.org`, 12 backup types, 7 retained per type
