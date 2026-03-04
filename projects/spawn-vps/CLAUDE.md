# spawn-vps — SPAWN VPS Deployment Toolkit

Bash deployment scripts for deploying the SPAWN daemon to any Ubuntu 24.04 VPS (amd64 or arm64). This is not a running service — it is a set of scripts run from the Pi to provision remote servers.

## Key Files
- `deploy.sh` — Main orchestrator (9 phases: SSH validate, bootstrap, scaling, upload, npm install, config, schema, PM2 start, healthcheck)
- `bootstrap-vps.sh` — System setup script that runs as root on the VPS (installs PostgreSQL, Node.js, PM2, nginx, etc.)
- `onboard.sh` — Interactive post-deploy wizard (Claude CLI, auth, GitHub, MCP settings)
- `package.sh` — Creates self-contained tarball for manual deployment
- `config.example.sh` — Configuration template (copy to `config.sh`)
- `lib/onboard-detect.sh` — Pure detection functions for onboarding status
- `templates/` — `.env`, PM2 ecosystem, and nginx config templates with `{{placeholders}}`

## Usage
```bash
cp config.example.sh config.sh   # Set VPS_HOST at minimum
bash deploy.sh                    # Full deploy
bash deploy.sh --update-only     # Update daemon bundle only
bash deploy.sh --package          # Create tarball
```

## How It Works
1. deploy.sh runs from the Pi, SSHs into the VPS
2. bootstrap-vps.sh installs all system deps, auto-scales memory to VPS RAM
3. Daemon bundle (dist/index.cjs + dashboard.html) is SCP'd from Pi
4. npm install rebuilds node-pty for target architecture
5. .env and ecosystem.config.cjs generated from templates
6. Database schema pushed from Pi's PostgreSQL
7. PM2 starts the daemon, healthcheck verifies

## Rules
- No port, no PM2 process — this is deployment tooling, not a service
- `config.sh` contains secrets — never commit it (see .gitignore)
- Default system user on VPS is `spawn` (configurable via SPAWN_USER)
- The daemon bundle comes from `/var/www/scws/daemon/dist/` — build it there first
