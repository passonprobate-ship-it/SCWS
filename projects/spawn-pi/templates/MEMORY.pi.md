# SPAWN Memory Index

## System Profile
- **Hardware**: {{PI_MODEL}}, {{RAM}} RAM
- **OS**: Ubuntu Server 24.04 ARM64
- **Hostname**: {{HOSTNAME}}
- **User**: {{USER}} (passwordless sudo)
- **Access**: Tailscale VPN
- **Base URL**: {{BASE_URL}}

## Default Memory System — spawn-mcp (LOCAL)
**spawn-mcp** (port 5020, localhost) is the DEFAULT MCP server for all project data, memories, and saves. Always use `spawn_remember`, `spawn_recall`, `spawn_list_memories`, `spawn_forget` for persistent memory operations. Do NOT default to external MCP servers for SPAWN project data — those are secondary/optional. All SPAWN project memories, notes, architecture docs, bootstrap fixes, deployment info, and general knowledge go to spawn-mcp first. This is a permanent system default.

## MANDATORY: Save Plan Before Starting Work
Before starting any non-trivial task, ALWAYS save the plan to spawn-mcp:
1. **Before work**: `spawn_remember` key `active-task-{project}` with full plan, steps, status "starting"
2. **During work**: Update the same key after each significant milestone (steps done, current step, decisions)
3. **On completion**: Update to status "complete" with summary, or "paused" with clear next steps
This ensures session disconnects don't lose progress — next Claude reads the memory and resumes.

## New Project Checklist
When creating a new project, ALWAYS do ALL of these steps:
1. Create project directory under `/var/www/scws/projects/<name>/`
2. Write code, install deps
3. Start with PM2 (`pm2 start ... --name <name>`)
4. Create nginx config in `/var/www/scws/nginx/projects/<name>.conf` + reload nginx
5. **Register project card in daemon** via `POST http://localhost:4000/api/projects` with Bearer token from `/var/www/scws/daemon/.env` (`DASHBOARD_TOKEN`), then PATCH to set status=running and description
6. `pm2 save` to persist across reboots
7. Update this MEMORY.md (port map + projects section)

## Port Map
- 4000: SPAWN daemon (fixed)
- 5001-5099: project range (auto-assigned)

## Hardware (Pi 5)
- **GPIO**: RP1 chip on gpiochip4 (54 lines) — use gpioget/gpioset or rpi-lgpio
- **I2C**: /dev/i2c-1 — use i2c-tools or Node i2c-bus
- **SPI**: /dev/spidev0.0 — use Node spi-device
- **PWM**: 2-channel on GPIO 12/13
- Old RPi.GPIO and pigpio do NOT work on Pi 5

## Daemon Restart Safety
- **You run inside scws-daemon.** Restarting it kills your session.
- **Project work NEVER needs a daemon restart** — projects are separate PM2 processes.
- **Never run `pm2 restart all`** — always restart projects individually by name.
- **Only restart daemon for**: changes to `daemon/dist/index.cjs`, `daemon/dist/dashboard.html`, `daemon/.env`, or `daemon/ecosystem.config.cjs`.
- **If you must restart**: batch changes, save state to spawn-mcp, warn user, restart as final command.

## Lessons Learned
- Pi 5 GPIO uses RP1 chip on gpiochip4 — old RPi.GPIO won't work, use rpi-lgpio or gpiod
- pigpio daemon does NOT work on Pi 5 — use lgpio/gpiod instead
- onoff (Node) has sysfs offset issue on Pi 5 — use gpioget/gpioset via child_process instead
- `printf` works reliably; `echo -n` does not in all shells
- PM2: use `--node-args="--env-file=.env"` for apps without dotenv; `pm2 save` + `pm2 startup` for reboot persistence
- Always register projects in both PM2 AND the daemon DB (projects table) — dashboard reads from DB
- Tailscale HTTPS certs may not be available on all account tiers — wire encryption only
- NVMe SSD via M.2 HAT+ recommended (5-10x faster than SD card for database workloads)

## Projects
(Projects will appear here as you create them)

## Detailed Notes
- Check spawn-mcp memories (`spawn_list_memories`) for architecture docs, deployment lessons, and saved plans
