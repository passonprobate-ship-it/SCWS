---
name: daemon-deploy
description: Safely apply SPAWN daemon changes — typecheck, rebuild, smoke-test on a throwaway port, commit, then restart scws-daemon LAST with explicit user approval. Use whenever daemon/*.ts, shared/schema.ts, or daemon/dist files changed and need to go live.
---

# Daemon Deploy — safe change workflow for scws-daemon

**You are running inside the daemon. Restarting it kills your own session.** The restart is always the final step, only with explicit user approval given in this session, and dispatched detached so it survives your death.

Work from `/var/www/scws` (repo root) throughout.

## 1. Batch all changes first

Finish every daemon edit before deploying. Never restart between edits. If only `daemon/dist/dashboard.html` changed, **stop after step 6 — the dashboard is hot-reloaded, no restart needed**.

## 2. Typecheck (must be 0 errors)

```bash
daemon/node_modules/.bin/tsc --noEmit -p tsconfig.json
```

The codebase typechecks clean as of v1.1.0. Keep it that way — fix any new error before proceeding.

## 3. Build from the repo root

```bash
daemon/node_modules/.bin/tsx script/build.ts
```

Never run the build from inside `daemon/` — the wrong cwd creates a stray `daemon/daemon/dist/`. Expected output: `daemon/dist/index.cjs` ~1.2 MB.

## 4. Syntax-check the bundle

```bash
node --check daemon/dist/index.cjs
```

## 5. Smoke-test on a throwaway port

```bash
cd /var/www/scws/daemon && PORT=4999 timeout 12 node --env-file=.env dist/index.cjs > /tmp/daemon-smoke.log 2>&1 &
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4999/        # expect 200
TOKEN=$(grep -oP '^DASHBOARD_TOKEN=\K.*' /var/www/scws/daemon/.env | tr -d '[:space:]')
curl -s "http://127.0.0.1:4999/api/projects" -H 'Authorization: Bearer '"$TOKEN"'' | head -c 100   # expect JSON
```

Also curl any endpoint you changed. If startup fails, the real error is at the **end** of `/tmp/daemon-smoke.log`, after the minified source dump. The throwaway instance shares the real DB (reads are fine); it dies by itself via `timeout`.

## 6. Commit and push

Commit daemon source AND `daemon/dist/index.cjs` together (other instances auto-update from the dist bundle). Push to master.

## 7. Save state, then ask

Save progress to spawn-mcp (`spawn_remember`, key `active-task-<topic>`) noting "restart pending". Then ask the user for permission to restart — **never restart without it**, even if they approved a restart earlier in another context.

## 8. Restart (detached) — the final act

```bash
setsid nohup pm2 restart scws-daemon --update-env >/tmp/daemon-restart.log 2>&1 &
```

Your session ends here. The next session verifies: `pm2 jlist` shows scws-daemon online, `curl localhost:4000` returns 200, and the PM2 error log is quiet.
