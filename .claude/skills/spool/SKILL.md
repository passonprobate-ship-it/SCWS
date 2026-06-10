---
name: spool
description: Spool a SPAWN project up or down with verification — daemon API start/stop, port listening, nginx path, registry status. Use for "start X", "stop X", "bring up X", "spin down X" on existing registered projects.
---

# Spool — start/stop a project, verified

Args: `<project-name> [up|down]` (default: up). Projects start **on demand** and only SPAWN core survives reboot — that's the design, not a fault.

## Spool UP

1. Prefer the daemon API — it rebuilds the full PM2 process (entry file, port, env, heap caps) from the registry, so the project doesn't need to exist in PM2:

```bash
TOKEN=$(grep -oP '^DASHBOARD_TOKEN=\K.*' /var/www/scws/daemon/.env | tr -d '[:space:]')
curl -s -X POST "http://localhost:4000/api/projects/<name>/start" -H 'Authorization: Bearer '"$TOKEN"''
```

Fallback if the daemon is down: `pm2 start <name>` (only works if the process exists in PM2).

2. Verify, in order:

```bash
pm2 jlist | jq -r '.[] | select(.name=="<name>") | .pm2_env.status'   # online
sleep 2 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/   # app answers directly
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/<name>/              # answers through nginx
```

Get the port from the registry (`GET /api/projects` or the DB), never guess. A 502 through nginx with a 200 direct hit means the nginx conf points at the wrong port. Android-framework projects have no server and no nginx conf — "running" doesn't apply; build/install them instead.

3. If it crashes on start: `pm2 logs <name> --lines 30 --nostream`, diagnose, fix, retry.

## Spool DOWN

```bash
curl -s -X POST "http://localhost:4000/api/projects/<name>/stop" -H 'Authorization: Bearer '"$TOKEN"''
```

Verify status `stopped` in PM2 and (within ~30s, via watchdog) in the registry.

## Rules

- **Never `pm2 save`** after spooling — the PM2 dump is the core-only boot baseline.
- **Never `pm2 restart all`** — the daemon is in that list; you'd kill your own session.
- The idle watchdog auto-stops projects after ~30 min idle (spawn-cortex and spawn-mcp exempt). If the user wants a project to stay up long-term, mention this; exemptions go in `_noAutoStop` in `daemon/watchdog.ts`.
