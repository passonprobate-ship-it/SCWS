# SPAWN Pi — Raspberry Pi Deployment Toolkit

Deploy the SPAWN daemon to any Raspberry Pi running Ubuntu Server 24.04 (arm64).

## Quick Start (3 commands)

```bash
cp config.example.sh config.sh
nano config.sh                    # Set PI_HOST
bash deploy.sh
```

## What This Does

1. **Bootstraps the Pi** — installs Node.js 20, PostgreSQL 16, nginx, PM2, Redis, GPIO tools, Chromium, Tailscale, Docker
2. **Configures hardware** — GPIO groups, udev rules, I2C/SPI/PWM/UART boot overlays
3. **Deploys the daemon** — uploads bundle, installs deps, generates .env, creates databases
4. **Seeds knowledge** — deploys Pi-specific CLAUDE.md, MEMORY.md, and MCP memory entries
5. **Starts everything** — PM2 daemon, health check, external verification

## Deploy Modes

| Flag | What It Does |
|------|-------------|
| *(none)* | Full deploy: bootstrap + daemon |
| `--bootstrap-only` | Just install system dependencies |
| `--update-only` | Skip bootstrap, update daemon bundle only |
| `--package` | Create tarball for manual deploy |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_HOST` | *(required)* | IP or hostname of target Pi |
| `PI_USER` | `root` | SSH user for initial setup |
| `PI_SSH_KEY` | *(default key)* | Path to SSH private key |
| `PI_SSH_PORT` | `22` | SSH port |
| `SPAWN_USER` | `codeman` | System user on the Pi |
| `SPAWN_HOSTNAME` | `SPAWN` | Hostname |
| `SPAWN_DB_PASSWORD` | *(auto-generated)* | PostgreSQL password |
| `SPAWN_DASHBOARD_TOKEN` | *(auto-generated)* | Dashboard auth token |
| `ENABLE_TAILSCALE` | `true` | Install Tailscale VPN |
| `ENABLE_GPIO` | `true` | GPIO groups, udev rules, boot overlays |
| `ENABLE_I2C` | `true` | I2C bus overlay |
| `ENABLE_SPI` | `true` | SPI bus overlay |
| `ENABLE_PWM` | `true` | PWM overlay (GPIO 12/13) |
| `ENABLE_UART` | `true` | Serial UART |
| `ENABLE_CHROMIUM` | `true` | Chromium snap + puppeteer-core |
| `INSTALL_DOCKER` | `true` | Docker (disabled at boot) |
| `EXTRA_DATABASES` | `spawn_cortex,solbot_db` | Extra PostgreSQL databases |

## Memory Scaling

The bootstrap auto-detects Pi RAM and scales accordingly:

| RAM | Swap | PG Connections | Daemon Heap | PM2 Restart |
|-----|------|----------------|-------------|-------------|
| <2GB | 2G | 15 | 96MB | 128M |
| 2GB | 2G | 20 | 128MB | 160M |
| 4GB | 4G | 30 | 192MB | 200M |
| 8GB | 4G | 30 | 192MB | 200M |

## Post-Deployment

After deploy completes:

1. **Reboot** to activate hardware overlays: `ssh root@<pi> 'sudo reboot'`
2. **Set up Tailscale**: `ssh root@<pi> 'sudo tailscale up --hostname=SPAWN'`
3. **Run onboarding** to set up Claude CLI, GitHub, and MCP:
   ```bash
   ssh root@<pi>
   sudo -u codeman bash /var/www/scws/onboard.sh
   ```
4. Open the dashboard at the Base URL shown after deploy

## Testing Bootstrap (Dry Run)

Preview what the bootstrap would do without making changes:

```bash
sudo SPAWN_DB_PASSWORD=test bash bootstrap-pi.sh --dry-run
```

## Manual Deploy (Tarball)

```bash
bash deploy.sh --package                              # Creates spawn-pi-YYYYMMDD.tar.gz
scp spawn-pi-*.tar.gz root@<pi>:/tmp/
ssh root@<pi>
cd /tmp && tar xzf spawn-pi-*.tar.gz && cd spawn-pi
cp config.example.sh config.sh && nano config.sh
export SPAWN_DB_PASSWORD=$(openssl rand -hex 24)
bash bootstrap-pi.sh
# Then manually copy daemon files and npm install
```

## Shared Files

These files are symlinked from `../spawn-vps/` to avoid duplication:
- `onboard.sh` — post-deploy onboarding wizard
- `seed-memory.sh` — universal MCP memory seeds
- `lib/onboard-detect.sh` — detection functions
- `templates/env.template` — .env template
- `templates/ecosystem.template.cjs` — PM2 config template
- `templates/nginx-site.template` — nginx config template
