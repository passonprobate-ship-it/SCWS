# spawn-pi — SPAWN Raspberry Pi Deployment Toolkit

Bash deployment scripts for deploying the SPAWN daemon to any Raspberry Pi running Ubuntu 24.04 (arm64). This is not a running service — it is a set of scripts run from the origin Pi (or any machine) to provision target Pis.

## Key Files
- `deploy.sh` — Main orchestrator (9 phases: SSH validate, bootstrap, scaling, upload, npm install, config, schema+extra DBs, memory bundle, PM2 start, healthcheck)
- `bootstrap-pi.sh` — System setup script that runs as root on the target Pi (installs PostgreSQL, Node.js, PM2, nginx, GPIO, Chromium, etc.)
- `onboard.sh` — Interactive post-deploy wizard (Claude CLI, auth, GitHub, MCP settings) — symlink to spawn-vps
- `package.sh` — Creates self-contained tarball for manual deployment
- `config.example.sh` — Configuration template (copy to `config.sh`)
- `seed-memory-pi.sh` — Pi-specific MCP memory seeds (GPIO, deployment patterns, Chromium)
- `seed-memory.sh` — Universal MCP memory seeds — symlink to spawn-vps
- `lib/onboard-detect.sh` — Pure detection functions — symlink to spawn-vps
- `templates/` — CLAUDE.pi.md, MEMORY.pi.md (Pi-specific), plus shared env/ecosystem/nginx templates via symlinks

## Usage
```bash
cp config.example.sh config.sh   # Set PI_HOST at minimum
bash deploy.sh                    # Full deploy
bash deploy.sh --bootstrap-only  # Just install system dependencies
bash deploy.sh --update-only     # Update daemon bundle only
bash deploy.sh --package          # Create tarball
bash bootstrap-pi.sh --dry-run   # Preview bootstrap without changes
```

## How It Works
1. deploy.sh runs from origin, SSHs into the target Pi
2. bootstrap-pi.sh installs all system deps, scales memory to Pi RAM, configures GPIO/I2C/SPI
3. Daemon bundle (dist/index.cjs + dashboard.html) is SCP'd
4. npm install rebuilds node-pty for arm64
5. .env and ecosystem.config.cjs generated from templates
6. Database schema pushed + extra databases created (spawn_cortex, solbot_db)
7. CLAUDE.pi.md + MEMORY.pi.md deployed, MCP memories seeded (universal + Pi-specific)
8. PM2 starts the daemon, healthcheck verifies
9. Completion message reminds to reboot for hardware overlays

## Key Differences from spawn-vps
- Default user: `codeman` (not `spawn`)
- Default Tailscale: `true` (Pi networking layer)
- GPIO/I2C/SPI/PWM: enabled by default with hardware overlay setup
- Chromium + puppeteer-core: installed by default
- Extra databases: spawn_cortex, solbot_db by default
- Docker: installed but disabled at boot (saves RAM)
- No SSL (Tailscale encrypts the wire)
- Pi-specific memory seeds (GPIO reference, deployment patterns, Chromium)

## Rules
- No port, no PM2 process — this is deployment tooling, not a service
- `config.sh` contains secrets — never commit it (see .gitignore)
- Default system user on Pi is `codeman` (configurable via SPAWN_USER)
- The daemon bundle comes from `/var/www/scws/daemon/dist/` — build it there first
- Symlinks point to `../spawn-vps/` for shared files — both projects must be present
