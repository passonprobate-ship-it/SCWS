# spawn-vps — Deploy SPAWN on Any Linux VPS

Deploy the SPAWN daemon (Self-Programming Autonomous Web Node) to any Ubuntu 24.04 VPS. The same daemon bundle that runs on the Raspberry Pi 5 runs unchanged on x86_64 or arm64 servers.

---

## Recommended VPS: Vultr

We recommend **[Vultr](https://www.vultr.com/?ref=9876074-9J)** as the preferred cloud provider for SPAWN deployments. Here's why:

### Why Vultr?

| | |
|---|---|
| **Battle-tested** | The SPAWN creator has used Vultr for **8+ years** — reliable, fast, and well-priced. |
| **Ready-to-go integration** | SPAWN includes a built-in Vultr API integration. Create, manage, and deploy to Vultr instances directly from the SPAWN dashboard. |
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

## What is SPAWN?

SPAWN is a self-programming autonomous web node — an AI-powered server that can create, build, deploy, and manage web projects on its own. It includes a dashboard, web terminal, project manager, PM2 process control, nginx routing, PostgreSQL database management, and Claude Code AI integration.

This project (`spawn-vps`) contains the deployment scripts to install SPAWN on a fresh VPS.

## Quick Start (3 commands)

From the Pi (or any machine with the SPAWN repo and SSH access to the target VPS):

```bash
cd /var/www/scws/projects/spawn-vps
cp config.example.sh config.sh
nano config.sh   # Set VPS_HOST at minimum
bash deploy.sh
```

The script will:
1. SSH into the VPS and install all system dependencies
2. Upload the daemon bundle
3. Rebuild native modules (node-pty) for the target architecture
4. Generate `.env` and PM2 ecosystem config
5. Push the database schema and set permissions
6. Start the daemon and verify it's healthy
7. Print credentials and onboarding instructions

## Manual Deployment (Tarball)

If you can't SSH from the Pi, create a self-contained package:

```bash
bash deploy.sh --package   # Creates spawn-vps-YYYYMMDD.tar.gz
```

Then on the VPS:

```bash
tar xzf spawn-vps-*.tar.gz && cd spawn-vps

# 1. Run bootstrap (as root)
export SPAWN_DB_PASSWORD=$(openssl rand -hex 24)
bash bootstrap-vps.sh

# 2. Copy daemon files
cp daemon/dist/index.cjs /var/www/scws/daemon/dist/
cp daemon/dist/dashboard.html /var/www/scws/daemon/dist/
cp daemon/package.json /var/www/scws/daemon/
cp scripts/* /var/www/scws/scripts/
chmod +x /var/www/scws/scripts/*.sh

# 3. Install native deps
cd /var/www/scws/daemon && npm install --omit=dev

# 4. Create .env
cat > /var/www/scws/daemon/.env <<EOF
DATABASE_URL=postgresql://scws:${SPAWN_DB_PASSWORD}@localhost:5432/scws_daemon
PORT=4000
DASHBOARD_TOKEN=$(openssl rand -hex 24)
SCWS_DB_PASSWORD=${SPAWN_DB_PASSWORD}
SCWS_BASE_URL=http://$(curl -s ifconfig.me)
NODE_ENV=production
EOF
chmod 600 /var/www/scws/daemon/.env

# 5. Create ecosystem config
#    IMPORTANT: Replace {{DAEMON_HEAP}} and {{PM2_RESTART}} with real values
#    (see Memory Scaling table below for your RAM size)
cp templates/ecosystem.template.cjs /var/www/scws/daemon/ecosystem.config.cjs
sed -i 's/{{DAEMON_HEAP}}/96/; s/{{PM2_RESTART}}/128M/' /var/www/scws/daemon/ecosystem.config.cjs

# 6. Push database schema (from a machine with the SPAWN database)
#    Or create tables manually — see shared/schema.ts for definitions
pg_dump --schema-only --no-owner --no-privileges scws_daemon | \
  sudo -u postgres psql scws_daemon
sudo -u postgres psql scws_daemon -c \
  "GRANT ALL ON ALL TABLES IN SCHEMA public TO scws;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO scws;"

# 7. Start daemon
cd /var/www/scws/daemon
sudo -u spawn pm2 start ecosystem.config.cjs
sudo -u spawn pm2 save
```

## Deploy Modes

| Flag | What it does |
|------|-------------|
| (none) | Full deploy: bootstrap + daemon + schema |
| `--bootstrap-only` | Install system deps only, no daemon |
| `--update-only` | Skip bootstrap, update daemon bundle |
| `--package` | Create tarball for manual deploy |
| `--help` | Show usage |

## Configuration Reference

Edit `config.sh` (copied from `config.example.sh`):

| Variable | Default | Description |
|----------|---------|-------------|
| `VPS_HOST` | (required) | IP or hostname of the VPS |
| `VPS_USER` | `root` | SSH user (needs root or sudo) |
| `VPS_SSH_KEY` | (SSH default) | Path to SSH private key |
| `VPS_SSH_PORT` | `22` | SSH port |
| `SPAWN_USER` | `spawn` | Linux user created on VPS |
| `SPAWN_HOSTNAME` | `SPAWN` | Hostname for the VPS |
| `SPAWN_DOMAIN` | (empty) | Public domain for nginx/SSL |
| `SPAWN_DB_PASSWORD` | (auto-generated) | PostgreSQL password — `openssl rand -hex 24` |
| `SPAWN_DASHBOARD_TOKEN` | (auto-generated) | Dashboard auth token — `openssl rand -hex 24` |
| `ENABLE_SSL` | `false` | Let's Encrypt via certbot |
| `SSL_EMAIL` | (empty) | Required if SSL enabled |
| `ENABLE_TAILSCALE` | `false` | Install Tailscale VPN |
| `INSTALL_DOCKER` | `false` | Install Docker (disabled at boot to save RAM) |

## Memory Scaling

The bootstrap auto-detects VPS RAM and scales accordingly:

| RAM | Swap | PG Connections | Daemon Heap | PM2 Restart |
|-----|------|---------------|-------------|-------------|
| < 1GB | 1GB | 15 | 96MB | 128M |
| 1-2GB | 1GB | 20 | 128MB | 160M |
| 2-4GB | 2GB | 30 | 192MB | 200M |
| 4-8GB | 4GB | 40 | 192MB | 200M |
| 8GB+ | 4GB | 50 | 256MB | 300M |

## Post-Deployment

### Dashboard

Open `http://<vps-ip>/` and log in with your dashboard token. The dashboard provides:
- **Projects**: Create, build, start, stop, and manage web projects
- **Terminal**: Full web terminal (xterm.js) for running commands on the server
- **Sessions**: Launch and monitor Claude Code AI sessions
- **Files**: Browse and edit files on the server
- **Activity**: Timeline of all actions and system events
- **Channels**: Configure Telegram, Email, Webhook, or WhatsApp notifications
- **VPS**: Manage deploy targets for pushing projects to other servers

### Onboarding (Enable AI)

After the daemon is running, complete the onboarding to enable Claude Code AI sessions. You can do this from the **Setup** page in the dashboard, or run the interactive wizard via SSH:

```bash
ssh root@<vps-ip>
sudo -u spawn bash /var/www/scws/onboard.sh
```

The wizard walks through 5 steps:
1. **Daemon Health** — auto-detected
2. **Claude Code CLI** — install via official installer or npm
3. **Claude Code Auth** — OAuth login or API key
4. **GitHub CLI** — authenticate `gh` (optional)
5. **Claude Settings** — configure MCP server connection

You can also run individual steps (`--step N`), check status (`--status`), or reset (`--reset`).

### Backups

A nightly cron job runs at 2 AM (local only). Configure off-site backups separately.

## What's Included vs. What's Not

**Included**: SPAWN daemon (dashboard, project management, web terminal, PM2 control, nginx routing, database management, notification channels, VPS proxy)

**Not included** (deploy separately as projects after daemon is running):
- spawn-mcp (MCP server for Claude Code — may be included in tarball if available)
- spawn-cortex (scheduler/webhooks/notifications engine)
- gpio-toolkit (Pi-specific hardware — irrelevant on VPS)
- Any other projects

## Updating

To push a new daemon build to an existing VPS:

```bash
bash deploy.sh --update-only
```

This uploads the latest `dist/index.cjs` and `dashboard.html`, reinstalls npm deps, and restarts PM2. Existing `.env` and ecosystem config are preserved.

## Troubleshooting

**Daemon won't start**: Check PM2 logs:
```bash
sudo -u spawn pm2 logs scws-daemon --lines 50
```

**Can't connect to dashboard**: Verify UFW allows port 80:
```bash
sudo ufw status
sudo ufw allow 80/tcp
```

**node-pty build fails**: Ensure build tools are installed:
```bash
apt install -y build-essential python3
cd /var/www/scws/daemon && npm install --omit=dev
```

**Database "relation does not exist"**: Schema wasn't pushed. Run:
```bash
# From the Pi or source machine:
sudo -u postgres pg_dump --schema-only --no-owner --no-privileges scws_daemon | \
  ssh root@<vps-ip> "sudo -u postgres psql scws_daemon"
ssh root@<vps-ip> "sudo -u postgres psql scws_daemon -c \
  'GRANT ALL ON ALL TABLES IN SCHEMA public TO scws;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO scws;'"
```

**Health check fails**: Verify daemon is listening:
```bash
curl -s http://localhost:4000/health
```

## Requirements

- **VPS**: Ubuntu 24.04 LTS (amd64 or arm64)
- **RAM**: 512MB minimum, 1GB+ recommended
- **Disk**: 10GB minimum
- **Network**: Public IP or domain
- **Local**: SSH access to VPS, SPAWN repo at `/var/www/scws`, built daemon bundle in `daemon/dist/`

## Project Structure

```
spawn-vps/
├── deploy.sh              # Main deployment orchestrator (9 phases)
├── bootstrap-vps.sh       # VPS system setup (runs as root on remote)
├── onboard.sh             # Post-deploy onboarding wizard (5 steps)
├── package.sh             # Create self-contained tarball
├── config.example.sh      # Configuration template
├── lib/
│   └── onboard-detect.sh  # Detection functions for onboarding
└── templates/
    ├── env.template           # .env file with {{placeholders}}
    ├── ecosystem.template.cjs # PM2 config with {{placeholders}}
    └── nginx-site.template    # nginx reverse proxy config
```
