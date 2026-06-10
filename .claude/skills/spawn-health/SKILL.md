---
name: spawn-health
description: Full SPAWN system checkup — core processes, daemon, registry drift, resources, backups, auto-update, nginx, git hygiene. Use when asked "how's the system", at session start after time away, or after an incident/reboot.
---

# SPAWN Health Check

Run the checks below (parallelize where possible), then report: **verdict first** (healthy / N issues), then each issue with evidence and a proposed fix. Don't apply fixes that change state without telling the user what you found — surface first, fix on request (or fix trivial/safe items and say so).

## 1. Core processes

```bash
pm2 jlist | jq -r '.[] | [.name, .pm2_env.status, (.pm2_env.restart_time|tostring)] | @tsv' | column -t
```

Expect `scws-daemon`, `spawn-mcp`, `pm2-logrotate` **online** with stable restart counts. Other projects may legitimately be stopped — only SPAWN core runs at boot (boot philosophy); a stopped project is NOT a fault. Rising restart counts or `errored` status are faults.

## 2. Daemon + dashboard

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/    # 200
sudo nginx -t                                                       # syntax ok
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/          # 200 via nginx
```

## 3. Registry vs PM2 drift

```bash
psql "postgresql://scws:$(grep -oP 'DATABASE_URL=postgresql://scws:\K[^@]+' /var/www/scws/daemon/.env)@localhost:5432/scws_daemon" \
  -t -A -F' | ' -c "SELECT name, status FROM projects ORDER BY name;"
```

Compare against `pm2 jlist`. The watchdog reconciles drift within ~30s; persistent mismatch means the watchdog is broken.

## 4. Resources

```bash
df -h / | tail -1            # < 80% used
free -h | head -2            # headroom available
cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null   # < 75000 (75°C)
```

## 5. Backups (nightly: local 2:00, off-site 2:15)

```bash
ls -lt /var/www/scws/logs/backup*.log* | head -4
zcat -f $(ls -t /var/www/scws/logs/backup.log* | head -1) | tail -5
```

A backup log older than ~26 hours or containing errors is a finding.

## 6. Auto-update (hourly cron, master only)

```bash
tail -10 /var/www/scws/logs/auto-update.log
crontab -l | grep auto-update || true
```

Repeated "skipping" warnings (wrong branch, dirty tree) mean updates are silently dead — that exact failure went unnoticed for a month once.

## 7. Git hygiene

```bash
git -C /var/www/scws status --short; git -C /var/www/scws branch -vv | head -2; git -C /var/www/scws stash list
```

Expect: clean tree, on `master`, in sync with origin, no stashes. Uncommitted `daemon/dist/*` changes are live-but-unsaved work — high priority finding.

## 8. Recent errors

```bash
psql "postgresql://scws:$(grep -oP 'DATABASE_URL=postgresql://scws:\K[^@]+' /var/www/scws/daemon/.env)@localhost:5432/scws_daemon" \
  -t -A -F' | ' -c "SELECT action, details, created_at FROM activity_log WHERE created_at > now() - interval '24 hours' AND action IN ('crashed','error','daemon_restart_pending','auto_update') ORDER BY created_at DESC LIMIT 10;"
tail -5 /home/codeman/.pm2/logs/scws-daemon-error.log
```
