# SPAWN — Self-Programming Autonomous Web Node

A server with a brain. SPAWN turns any Ubuntu machine into an autonomous development environment powered by Claude AI. Describe what you want in plain English — a REST API, a dashboard, a bot, a full-stack app — and SPAWN writes the code, installs dependencies, creates the database, configures the reverse proxy, starts the process, and makes it live at a real URL. No deploying. No DevOps. No manual steps. Just ideas in, running software out.

It manages its own infrastructure. It monitors its own health. It fixes its own bugs. It remembers what it built and picks up where it left off. You talk to it through a sleek dark-mode dashboard with a built-in terminal, live Claude sessions, file editor, and one-click deploys to external servers. Every project it creates is production-ready and running in seconds.

One machine. One install. Unlimited projects. From a $60 Raspberry Pi on your desk to a $5/mo cloud VPS — SPAWN turns commodity hardware into your personal autonomous software factory.

---

### Requires Claude Max

SPAWN is powered by Claude Code CLI, which requires an active **[Claude Max subscription](https://claude.com/pricing)** ($100/month from Anthropic). This is what gives SPAWN its brain — without it, there's no AI. If you don't have one yet, **[go sign up now](https://claude.com/pricing)** before continuing. Once subscribed, the install script handles the rest.

---

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
# On a Raspberry Pi:
sudo -u spawn bash /var/www/scws/projects/spawn-pi/onboard.sh
# On a VPS:
sudo -u spawn bash /var/www/scws/projects/spawn-vps/onboard.sh
```

---

## Recommended VPS: Vultr

We recommend **[Vultr](https://www.vultr.com/?ref=9876074-9J)** as the preferred cloud provider for SPAWN deployments.

### Why Vultr?

| | |
|---|---|
| **Battle-tested** | The SPAWN creator has used Vultr for **8+ years** — reliable, fast, and well-priced. |
| **Built-in integration** | SPAWN includes a Vultr API integration. Create, manage, and deploy to Vultr instances directly from the dashboard. |
| **Global footprint** | 32 data centers worldwide with hourly billing starting at $2.50/month. |

### Get Started with Free Credit

| Plan | Deal | Link |
|------|------|------|
| **New users** (< $100/mo) | Start with Vultr — great pricing, no commitment | [**Sign up with Vultr**](https://www.vultr.com/?ref=6816669) |
| **Power users** ($100+/mo) | Get **$300 free credit** to test the platform* | [**Claim $300 Credit**](https://www.vultr.com/?ref=9876074-9J) |

> *$300 credit requires a valid credit card or PayPal. Unused credit expires after 30 days. Referred users must be active 30+ days and use at least $100 in payments.

### Recommended Plans for SPAWN

| Plan | Specs | Price | Best for |
|------|-------|-------|----------|
| `vc2-1c-1gb` | 1 vCPU, 1GB RAM, 25GB SSD | $6/mo | Minimal SPAWN — dashboard + 1-2 projects |
| `vc2-1c-2gb` | 1 vCPU, 2GB RAM, 55GB SSD | $10/mo | **Recommended** — comfortable for AI sessions |
| `vc2-2c-4gb` | 2 vCPU, 4GB RAM, 80GB SSD | $20/mo | Multiple projects + Claude Code sessions |

Using the links above helps support SPAWN development at no extra cost to you.

---

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
│   ├── dist/dashboard.html   ← Web dashboard SPA (single-file, ~7400 lines)
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

![SPAWN Help Center](https://raw.githubusercontent.com/passonprobate-ship-it/SCWS/master/docs/screenshot-help.png)

![SPAWN System Monitor](https://raw.githubusercontent.com/passonprobate-ship-it/SCWS/master/docs/screenshot-system.png)

![SPAWN Claude Sessions](https://raw.githubusercontent.com/passonprobate-ship-it/SCWS/master/docs/screenshot-sessions.png)

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

### Memory Scaling by RAM

| RAM | Swap | PG Connections | Daemon Heap | PM2 Restart |
|-----|------|---------------|-------------|-------------|
| < 1GB | 1GB | 15 | 96MB | 128M |
| 1-2GB | 1GB | 20 | 128MB | 160M |
| 2-4GB | 2GB | 30 | 192MB | 200M |
| 4-8GB | 4GB | 40 | 192MB | 200M |
| 8GB+ | 4GB | 50 | 256MB | 300M |

## VPS Deployment

For deploying SPAWN to a remote VPS from the Pi (or any machine with SSH access):

```bash
cd /var/www/scws/projects/spawn-vps
cp config.example.sh config.sh
nano config.sh   # Set VPS_HOST at minimum
bash deploy.sh
```

| Deploy Flag | What it does |
|-------------|-------------|
| *(none)* | Full deploy: bootstrap + daemon + schema |
| `--bootstrap-only` | Install system deps only, no daemon |
| `--update-only` | Skip bootstrap, update daemon bundle |
| `--package` | Create self-contained tarball for manual deploy |

### Post-Deployment

Open `http://<vps-ip>/` and log in with your dashboard token. Then run the onboarding wizard to enable Claude Code AI sessions:

```bash
ssh root@<vps-ip>
sudo -u spawn bash /var/www/scws/projects/spawn-vps/onboard.sh
```

## Troubleshooting

**Daemon won't start**: Check PM2 logs:
```bash
pm2 logs scws-daemon --lines 50
```

**Can't connect to dashboard**: Verify firewall allows port 80:
```bash
sudo ufw status
sudo ufw allow 80/tcp
```

> **Security note**: The dashboard provides full terminal access and project control. Use Tailscale, a VPN, or firewall rules to restrict who can reach port 80. The bearer token is transmitted over HTTP — use a reverse proxy with SSL for internet-facing deployments.

**node-pty build fails**: Ensure build tools are installed:
```bash
apt install -y build-essential python3
cd /var/www/scws/daemon && npm install --omit=dev
```

**Database errors**: Push schema and fix permissions:
```bash
sudo -u postgres psql scws_daemon -f /var/www/scws/scripts/schema.sql
sudo -u postgres psql scws_daemon -c \
  "GRANT ALL ON ALL TABLES IN SCHEMA public TO scws;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO scws;"
```

**Health check fails**: Verify daemon is listening:
```bash
curl -s http://localhost:4000/health
```

## Requirements

- Ubuntu 20.04, 22.04, or 24.04
- amd64 or arm64
- 512MB RAM minimum (2+ GB recommended)
- Root access

## License

MIT
