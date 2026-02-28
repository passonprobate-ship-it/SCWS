# Setup Guide

## Prerequisites

- Node.js 20+
- PostgreSQL 16
- Target hardware: Raspberry Pi 5 (8GB), Ubuntu Server 24.04 ARM64
- Tailscale VPN for network access

## Local Development

```bash
git clone git@github.com:passonprobate-ship-it/SCWS.git
cd SCWS
npm install
```

Create `daemon/.env`:

```env
DATABASE_URL=postgresql://scws:yourpassword@localhost:5432/scws_daemon
PORT=4000
DASHBOARD_TOKEN=your-64-char-hex-token
SCWS_DB_PASSWORD=yourpassword
SCWS_BASE_URL=http://localhost
NODE_ENV=development
```

Start the dev server:

```bash
npm run dev
```

Dashboard available at `http://localhost:4000`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Daemon port (default: 4000) |
| `DASHBOARD_TOKEN` | Yes | Bearer token for API authentication |
| `SCWS_DB_PASSWORD` | Yes | PostgreSQL password (used when creating per-project DBs) |
| `SCWS_BASE_URL` | No | Base URL for nginx configs (default: http://localhost) |
| `NODE_ENV` | No | `development` or `production` |

## Database Setup

Create the PostgreSQL user and database:

```bash
sudo -u postgres psql -c "CREATE USER scws WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE scws_daemon OWNER scws;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE scws_daemon TO scws;"
```

Create all 6 tables:

```sql
-- Connect: psql -U scws scws_daemon

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'stopped',
  framework TEXT NOT NULL DEFAULT 'express',
  git_repo TEXT,
  git_branch TEXT NOT NULL DEFAULT 'main',
  db_name TEXT,
  entry_file TEXT NOT NULL DEFAULT 'dist/index.js',
  build_command TEXT,
  start_command TEXT,
  env_vars TEXT NOT NULL DEFAULT '{}',
  deploy_targets TEXT NOT NULL DEFAULT '[]',
  last_build_at TIMESTAMP,
  last_deploy_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claude_runs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id VARCHAR NOT NULL,
  project_name TEXT,
  prompt TEXT NOT NULL,
  output TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  mode TEXT NOT NULL DEFAULT 'build',
  session_id TEXT,
  turn_number INTEGER NOT NULL DEFAULT 1,
  parent_run_id VARCHAR,
  duration INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id VARCHAR,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daemon_config (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  status_message TEXT,
  last_tested_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel_id VARCHAR NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_channel ON notifications(channel_id);
GRANT ALL ON ALL TABLES IN SCHEMA public TO scws;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO scws;
```

## Building

```bash
npx tsx script/build.ts
```

Produces:
- `dist/index.cjs` — Single bundled CJS file (esbuild, minified)
- `dist/dashboard.html` — Copied from daemon/dashboard.html

The build bundles most dependencies into the CJS file. Only `node-pty` and `ws` are external (they have native bindings).

## Fresh Pi Provisioning

For a brand-new Pi, run `scripts/bootstrap.sh` as root. It performs 11 steps:

1. System packages (nginx, PostgreSQL, fail2ban, build tools)
2. Tailscale VPN
3. Firewall (UFW — Tailscale + SSH + HTTP only)
4. fail2ban (SSH brute-force protection)
5. Node.js 20 (via NodeSource)
6. Global npm tools (PM2, TypeScript, tsx, esbuild)
7. Claude CLI (installed for the `codeman` user)
8. GitHub CLI
9. PostgreSQL (user: scws, database: scws_daemon, tables created)
10. Directory structure + .env file
11. nginx (HTTP reverse proxy, Tailscale-only access)

After bootstrap, manually:

```bash
# Authenticate Claude CLI (one-time, interactive)
claude

# Authenticate GitHub CLI (one-time, interactive)
gh auth login
```

## Deploy After Bootstrap

```bash
# On your dev machine:
npx tsx script/build.ts
scp dist/* codeman@100.89.2.95:/var/www/scws/daemon/dist/
scp package.json codeman@100.89.2.95:/var/www/scws/daemon/

# On the Pi:
cd /var/www/scws/daemon
npm install --omit=dev
pm2 start dist/index.cjs --name scws-daemon
pm2 save
```
