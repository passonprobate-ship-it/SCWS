# Operations Runbook

## Deploying Updates

Build locally, copy to Pi, restart:

```bash
# 1. Build
npx tsx script/build.ts

# 2. Deploy
scp dist/* codeman@100.89.2.95:/var/www/scws/daemon/dist/

# 3. Restart
ssh codeman@100.89.2.95 'pm2 restart scws-daemon'

# 4. Verify
ssh codeman@100.89.2.95 'pm2 logs scws-daemon --lines 10 --nostream'
```

If dependencies changed, also copy `package.json` and run `npm install --omit=dev` on the Pi before restarting.

## Database Migrations

SPAWN uses Drizzle ORM but does **not** use migration files in production. Instead:

1. Update `shared/schema.ts` with the new column/table
2. SSH to the Pi and run the ALTER TABLE SQL directly:

```bash
ssh codeman@100.89.2.95
source /var/www/scws/daemon/.env
psql "$DATABASE_URL" -c "ALTER TABLE projects ADD COLUMN new_field TEXT;"
```

For new tables, run the full CREATE TABLE statement. Always `GRANT ALL ON <table> TO scws;`.

## Adding a New Project

**Via Dashboard**: Click "New Project" (Ctrl+N), fill in name/display name/framework, submit.

**Via API**:
```bash
curl -X POST http://100.89.2.95/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","displayName":"My App","framework":"express"}'
```

**Via Import**: Ctrl+I in dashboard, or:
```bash
curl -X POST http://100.89.2.95/api/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/user/repo"}'
```

The daemon auto-assigns a port (5001+), generates an nginx config, and registers the project in the database.

## Monitoring

### Health Check Script

`scripts/healthcheck.sh` checks nginx, PostgreSQL, daemon, fail2ban, disk, and memory. Set it up as a cron job:

```bash
crontab -e
# Add:
*/5 * * * * /var/www/scws/scripts/healthcheck.sh
```

State is written to `/var/www/scws/logs/health-state.json`. The script auto-restarts the daemon if it's down.

### PM2 Logs

```bash
# Daemon logs
pm2 logs scws-daemon --lines 50

# Project logs
pm2 logs scws-my-project --lines 50

# All processes
pm2 logs --lines 20
```

### System Info API

```bash
curl -H "Authorization: Bearer $TOKEN" http://100.89.2.95/api/system
```

Returns disk usage, memory, uptime, project counts, and daemon process info.

### PM2 Process List

```bash
pm2 list                    # Quick overview
pm2 monit                   # Real-time monitoring
pm2 show scws-daemon        # Detailed process info
```

## Notification Channels

### Setting Up Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token (format: `123456789:ABCdef...`)
3. Dashboard → Channels → Add Channel → Telegram
4. Enter a name and paste the bot token → daemon validates via `getMe` API
5. Start a chat with your bot on Telegram (or add it to a group)
6. Get the chat ID (send a message, then check `https://api.telegram.org/bot<TOKEN>/getUpdates`)
7. Dashboard → click "Verify" on the channel → enter the chat ID
8. Daemon sends a confirmation message → channel is now verified and active

### Setting Up Email (AgentMail)

1. Create an account at [agentmail.to](https://agentmail.to)
2. Create an inbox and note the inbox ID
3. Get your API key from the AgentMail dashboard
4. Dashboard → Channels → Add Channel → Email
5. Enter: name, API key, inbox ID, recipient email address
6. Daemon validates the inbox via AgentMail API → channel is immediately verified

### Notification Rules

Dashboard → Channels → Notification Rules section. Toggle which events trigger notifications:

| Event | Default | What triggers it |
|-------|---------|-----------------|
| Build failed | On | `buildProject()` fails |
| Build succeeded | Off | `buildProject()` succeeds |
| Project started | Off | `startProject()` called |
| Project stopped | Off | `stopProject()` called |
| Project crashed | On | PM2 detects process crash |
| Claude completed | On | Claude run finishes OK |
| Claude failed | On | Claude run errors out |
| System health | On | Health check detects issues |

Rules are stored in the `daemon_config` table under the key `notification-rules`.

## Troubleshooting

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| **Daemon won't start** | `pm2 logs scws-daemon` — check for missing .env or DB connection errors | Verify `.env` exists at `/var/www/scws/daemon/.env` with correct `DATABASE_URL` |
| **nginx 502 Bad Gateway** | Daemon not running or wrong port | `pm2 restart scws-daemon`, check daemon is on port 4000 |
| **Dashboard blank** | Missing `dist/dashboard.html` | Re-deploy: `scp dist/dashboard.html codeman@100.89.2.95:/var/www/scws/daemon/dist/` |
| **Claude CLI fails** | Auth expired or not configured | SSH to Pi, run `claude` interactively to re-authenticate |
| **GitHub CLI fails** | Auth expired | SSH to Pi, run `gh auth login` |
| **Notifications not sending** | Channel not verified, disabled, or rules off | Check channel: `verified=1`, `enabled=1`. Check rules in dashboard. |
| **Build fails on Pi** | Missing native deps (node-pty needs build tools) | `sudo apt install build-essential python3` on Pi |
| **Port conflict** | Two projects assigned the same port | Check `projects` table, update port manually via `psql` |
| **DB connection refused** | PostgreSQL not running | `sudo systemctl start postgresql` |
| **Tailscale unreachable** | VPN not connected | `sudo tailscale up` on Pi, verify with `tailscale status` |

### Checking Service Status

```bash
systemctl status nginx
systemctl status postgresql
systemctl status fail2ban
tailscale status
pm2 list
```

### Restarting Everything

```bash
sudo systemctl restart nginx
sudo systemctl restart postgresql
pm2 restart all
```

## Backup

### Database Backup

```bash
# Daemon database
pg_dump -U scws scws_daemon > scws_daemon_backup.sql

# Per-project databases (if any)
pg_dump -U scws project_db_name > project_backup.sql

# Restore
psql -U scws scws_daemon < scws_daemon_backup.sql
```

### Code Backup

All code is on GitHub at `passonprobate-ship-it/SCWS`. Project source lives in `/var/www/scws/projects/` — individual projects may have their own git repos.

### PM2 Process List

```bash
pm2 save          # Saves current process list
pm2 resurrect     # Restores saved processes after reboot
```

PM2 is configured for auto-startup via systemd (set up by bootstrap.sh).

## Hosted Projects

| Project | Port | PM2 Name | Database | Description |
|---------|------|----------|----------|-------------|
| artsys | 5001 | scws-artsys | artsys | Art inventory management |
| spawn-cortex | 5002 | scws-spawn-cortex | spawn_cortex | System monitoring + cron + webhooks |
| gpio-toolkit | 5010 | scws-gpio-toolkit | — | GPIO REST API for Pi hardware |

Access via: `http://100.89.2.95/<project-name>/`

### spawn-cortex Details

spawn-cortex is embedded in the SPAWN dashboard via iframe (Ctrl+6). It's a separate Express app with its own database (`spawn_cortex`) and auth token.

- **Dashboard**: `http://100.89.2.95/spawn-cortex/` (standalone) or Cortex tab in SPAWN dashboard
- **Auth token**: In `/var/www/scws/projects/spawn-cortex/.env` (`AUTH_TOKEN`)
- **Features**: System health monitoring, cron scheduler (healthcheck/shell/http/pm2_restart tasks), webhook ingress (`/hook/:slug`), Telegram/Discord notifications
- **Database tables**: `scheduled_tasks`, `task_runs`, `webhooks`, `webhook_events`, `notification_channels`, `notifications`
- **Logs**: `pm2 logs spawn-cortex --lines 30`

## Pi Hardware Info

- **Model**: Raspberry Pi 5, 8GB RAM
- **Storage**: SD card (monitor disk usage — keep below 80%)
- **OS**: Ubuntu Server 24.04 ARM64
- **Network**: Tailscale VPN only (no public internet exposure)
- **Additional software**: Docker CE (idle), Redis (empty), ffmpeg, ImageMagick, Go, ripgrep, chromium
