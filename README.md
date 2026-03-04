# SPAWN — Self-Programming Autonomous Web Node

An autonomous server that programs itself. Give it a prompt, and it writes the code, installs dependencies, configures the database, sets up the reverse proxy, starts the process, and makes it live — all by itself. Powered by Claude AI.

Runs on any Ubuntu server — from a Raspberry Pi to a cloud VPS.

## Quick Install

Deploy SPAWN on any fresh Ubuntu server (20.04/22.04/24.04, amd64 or arm64) with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/passonprobate-ship-it/SCWS/master/scripts/install.sh | bash
```

This installs everything: Node.js, PostgreSQL, nginx, PM2, the SPAWN daemon, and sets up auto-updates. Takes about 3-5 minutes. Run as root on a fresh server.

**Optional environment variables** (set before running):

| Variable | Default | Description |
|----------|---------|-------------|
| `SPAWN_USER` | `spawn` | Linux user to create |
| `SPAWN_HOSTNAME` | `SPAWN` | Server hostname |
| `SPAWN_DOMAIN` | *(none)* | Public domain for nginx |
| `ENABLE_SSL` | `false` | Let's Encrypt SSL |
| `SSL_EMAIL` | *(none)* | Email for Let's Encrypt |
| `ENABLE_TAILSCALE` | `false` | Install Tailscale VPN |
| `INSTALL_DOCKER` | `false` | Install Docker |

Example with options:

```bash
SPAWN_DOMAIN=spawn.example.com ENABLE_SSL=true SSL_EMAIL=you@example.com \
  curl -fsSL https://raw.githubusercontent.com/passonprobate-ship-it/SCWS/master/scripts/install.sh | bash
```

After install, run the onboarding wizard to set up Claude Code CLI and authentication:

```bash
sudo -u spawn bash /var/www/scws/projects/spawn-vps/onboard.sh
```

## What It Does

You open the dashboard, type a prompt like "build me a URL shortener with analytics", and SPAWN:

1. Creates the project directory and writes all the code
2. Installs npm dependencies
3. Creates a PostgreSQL database and runs migrations
4. Generates an nginx reverse proxy config
5. Starts the process with PM2
6. Confirms it's live and accessible

If something breaks, it reads the logs, diagnoses the issue, fixes it, and redeploys.

## Architecture

```
/var/www/scws/
├── daemon/                   ← Control plane (Express 5, port 4000)
│   ├── dist/index.cjs        ← Built daemon bundle
│   ├── dist/dashboard.html   ← Web dashboard SPA (single-file, ~5400 lines)
│   ├── .env                  ← DATABASE_URL, DASHBOARD_TOKEN, etc.
│   └── ecosystem.config.cjs  ← PM2 config with heap caps
├── projects/                 ← AI-created projects live here
│   └── <project-name>/       ← Each project is self-contained
├── nginx/projects/           ← Auto-generated per-project nginx configs
├── scripts/
│   ├── install.sh            ← One-line installer for fresh servers
│   ├── auto-update.sh        ← Polling auto-update engine (cron)
│   ├── schema.sql            ← Database DDL (8 tables)
│   ├── bootstrap.sh          ← Full system bootstrap (Pi)
│   ├── backup-db.sh          ← Nightly local DB backup
│   └── backup-offsite.sh     ← Nightly off-site backup (12 types)
├── backups/                  ← Local backup rotation (7 days)
├── logs/
├── CLAUDE.md                 ← AI instructions (loaded every session)
└── README.md
```

## Dashboard

The web dashboard is a single-file SPA at `http://<host>/` providing full control over the system.

| Page | Shortcut | Description |
|------|----------|-------------|
| Terminal | `Ctrl+J` | Interactive Claude AI terminal — type prompts and watch it work |
| Sessions | — | View and resume previous Claude AI sessions |
| Projects | `Ctrl+1` | Create, start, stop, build, deploy, view logs |
| System | `Ctrl+2` | CPU, memory, disk, temperature, PM2 process status |
| Activity | `Ctrl+3` | Timeline of all actions |
| MCP | `Ctrl+4` | MCP server status and persistent memory |
| Channels | `Ctrl+5` | Notification channels — email, webhook, alerts |
| Cortex | `Ctrl+6` | Scheduler, cron jobs, webhook ingress |
| Files | `Ctrl+7` | Server filesystem browser |
| Connections | `Ctrl+8` | External service connections |
| VPS | `Ctrl+9` | Remote deploy targets |
| `Ctrl+K` | | Command palette |

## Tech Stack

- **Platform**: Ubuntu Server (Raspberry Pi, VPS, bare metal — amd64 or arm64)
- **Runtime**: Node.js 20+ / TypeScript 5.6
- **Daemon**: Express 5 on port 4000
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Build**: esbuild → single CJS bundle + dashboard HTML
- **Process Manager**: PM2 with pm2-logrotate
- **Reverse Proxy**: nginx
- **Frontend**: Single-file SPA — vanilla JS, no framework
- **Auth**: Bearer token with timing-safe compare
- **AI**: Claude Code CLI (headless sessions)
- **VCS**: Git + GitHub CLI (`gh`)
- **Updates**: Auto-update via git polling (every 5 minutes)

## Database

PostgreSQL user `scws`, database `scws_daemon`.

| Table | Purpose |
|-------|---------|
| `projects` | Project registry (name, port, status, framework, git, deploy targets) |
| `claude_runs` | Claude session history (prompt, output, mode, session, duration) |
| `activity_log` | All system actions (created, built, deployed, started, stopped) |
| `daemon_config` | Key-value daemon settings |
| `spawn_memories` | Persistent key-value memory for MCP server |
| `channels` | Notification channel configuration |
| `connections` | External service connections |
| `notifications` | Notification delivery log |

Additional per-project databases are created on demand.

## Port Map

| Port | Service |
|------|---------|
| 4000 | SPAWN daemon (fixed) |
| 5001–5099 | Project range (auto-assigned) |

## Memory Management

Auto-scales to available RAM. Defense-in-depth across 3 layers:

- **System tuning**: `vm.swappiness=5`, swap sized to RAM, Docker disabled at boot
- **PM2 heap caps**: Per-process `--max-old-space-size` and `max_memory_restart` limits
- **Watchdog**: 70% warn, 85% auto-stop idle projects, 93% emergency stop + drop caches
- **OOM killer**: Custom scores — PM2 god daemon protected, projects expendable

## Requirements

- Ubuntu 20.04, 22.04, or 24.04
- amd64 or arm64
- 1 GB RAM minimum (2+ GB recommended)
- Root access

## License

MIT
