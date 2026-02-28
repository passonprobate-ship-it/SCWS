#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════
# SPAWN Bootstrap Script — Raspberry Pi 5 + Tailscale
# Self-Programming Autonomous Web Node
# Provisions a fresh Ubuntu Server 24.04 ARM64 Pi into a dev server
# Run as: sudo bash bootstrap.sh
# ═══════════════════════════════════════════════════════════════════

# ── Configuration (edit these before running) ─────────────────────

SCWS_USER="codeman"              # non-root user who runs the daemon
DASHBOARD_TOKEN="b3089956e81b8b8c11979d66b8e31776178f67d79da18a5670374810433d2ad1"
DB_PASSWORD="scws_$(openssl rand -hex 8)"
MCP_SERVER_URL="https://passoncloud.duckdns.org/mcp"
MCP_SERVER_TOKEN="2c86de7bd448b5f21614599cae27ceccdca921756ec2f8d1ed3e4c8a8e178ce8"
DUCKDNS_DOMAIN=""                # e.g. "spawn" — leave empty to skip DuckDNS
DUCKDNS_TOKEN=""                 # DuckDNS token — leave empty to skip

SCWS_HOME=$(eval echo "~${SCWS_USER}")

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Run this script as root (sudo bash bootstrap.sh)"
  exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  SPAWN Bootstrap — Raspberry Pi 5 Provisioning"
echo "═══════════════════════════════════════════════════════"

# ── Step 1: System packages ───────────────────────────────────────
echo ""
echo "▸ Step 1/15: Installing system packages..."

apt update && apt upgrade -y
apt install -y \
  nginx postgresql postgresql-contrib fail2ban \
  curl wget git build-essential \
  python3 python3-pip python3-venv \
  jq htop tmux unzip \
  software-properties-common \
  ffmpeg imagemagick \
  ripgrep \
  chromium-browser

echo "  ✓ System packages installed"

# ── Step 2: Tailscale ────────────────────────────────────────────
echo ""
echo "▸ Step 2/15: Installing Tailscale..."

if ! command -v tailscale &>/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# Check if already connected
if ! tailscale status &>/dev/null; then
  echo "  Starting Tailscale..."
  tailscale up
fi

TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "unknown")
TAILSCALE_HOSTNAME=$(tailscale status --self --json 2>/dev/null | jq -r '.Self.DNSName // "unknown"' | sed 's/\.$//')

echo "  ✓ Tailscale connected"
echo "  Tailscale IP: ${TAILSCALE_IP}"
echo "  Hostname:     ${TAILSCALE_HOSTNAME}"

# ── Step 3: Firewall (Tailscale-friendly) ─────────────────────────
echo ""
echo "▸ Step 3/15: Configuring firewall..."

# Allow Tailscale interface, block public access
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 22/tcp   # SSH (local network for initial setup)
ufw allow 80/tcp   # HTTP (nginx → dashboard + projects)
ufw --force enable

echo "  ✓ Firewall configured (Tailscale + SSH + HTTP)"

# ── Step 4: fail2ban ──────────────────────────────────────────────
echo ""
echo "▸ Step 4/15: Configuring fail2ban..."

cat > /etc/fail2ban/jail.local << 'JAIL'
[DEFAULT]
bantime = 1800
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = %(sshd_log)s
JAIL

systemctl enable fail2ban
systemctl restart fail2ban

echo "  ✓ fail2ban configured"

# ── Step 5: Node.js 20 ───────────────────────────────────────────
echo ""
echo "▸ Step 5/15: Installing Node.js 20..."

if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "  Node.js $(node --version)"
echo "  npm $(npm --version)"
echo "  ✓ Node.js installed"

# ── Step 6: Global npm tools ─────────────────────────────────────
echo ""
echo "▸ Step 6/15: Installing global npm tools..."

npm install -g pm2 typescript tsx esbuild

echo "  ✓ PM2, TypeScript, tsx, esbuild installed globally"

# ── Step 7: Claude CLI ───────────────────────────────────────────
echo ""
echo "▸ Step 7/15: Installing Claude CLI..."

if ! su - "${SCWS_USER}" -c "command -v claude" &>/dev/null; then
  su - "${SCWS_USER}" -c "curl -fsSL https://claude.ai/install.sh | bash"
fi

# Claude CLI settings
su - "${SCWS_USER}" -c "mkdir -p ${SCWS_HOME}/.claude"
cat > "${SCWS_HOME}/.claude/settings.json" << EOF
{
  "mcpServers": {
    "claude-persistent": {
      "type": "streamableHttp",
      "url": "${MCP_SERVER_URL}",
      "headers": {
        "Authorization": "Bearer ${MCP_SERVER_TOKEN}"
      }
    }
  },
  "permissions": {
    "allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]
  }
}
EOF
chown "${SCWS_USER}:${SCWS_USER}" "${SCWS_HOME}/.claude/settings.json"

echo "  ✓ Claude CLI installed for ${SCWS_USER}"
echo "  NOTE: Run 'claude' interactively to authenticate with Claude Max"

# ── Step 8: GitHub CLI ───────────────────────────────────────────
echo ""
echo "▸ Step 8/15: Installing GitHub CLI..."

if ! command -v gh &>/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  apt update && apt install -y gh
fi

echo "  ✓ GitHub CLI installed"
echo "  NOTE: Run 'gh auth login' as ${SCWS_USER} after bootstrap"

# ── Step 9: Docker CE + Redis ────────────────────────────────────
echo ""
echo "▸ Step 9/15: Installing Docker CE + Redis..."

# Docker CE
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "${SCWS_USER}"
fi
systemctl enable docker

# Redis
if ! command -v redis-server &>/dev/null; then
  apt install -y redis-server
fi
systemctl enable redis-server
systemctl start redis-server

echo "  ✓ Docker CE installed (user ${SCWS_USER} added to docker group)"
echo "  ✓ Redis installed and running"

# ── Step 10: Go + GPIO libraries ─────────────────────────────────
echo ""
echo "▸ Step 10/15: Installing Go + GPIO libraries..."

# Go (latest stable via snap or manual — use apt for simplicity)
if ! command -v go &>/dev/null; then
  apt install -y golang-go
fi

# GPIO libraries for Raspberry Pi hardware access
apt install -y \
  libgpiod-dev gpiod \
  python3-gpiod python3-lgpio python3-rpi.gpio \
  i2c-tools python3-smbus \
  2>/dev/null || true  # Some packages may not exist on all Ubuntu versions

echo "  Go $(go version 2>/dev/null | awk '{print $3}' || echo 'installed')"
echo "  ✓ Go + GPIO libraries installed"

# ── Step 11: PostgreSQL ──────────────────────────────────────────
echo ""
echo "▸ Step 11/15: Configuring PostgreSQL..."

systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='scws'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER scws WITH PASSWORD '${DB_PASSWORD}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='scws_daemon'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE scws_daemon OWNER scws;"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE scws_daemon TO scws;"

# Create all 6 tables matching Drizzle schema (shared/schema.ts)
sudo -u postgres psql scws_daemon << 'SQL'
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

CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel_id);

GRANT ALL ON ALL TABLES IN SCHEMA public TO scws;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO scws;
SQL

echo "  ✓ PostgreSQL configured (user: scws, db: scws_daemon, 6 tables created)"
echo "  DB Password: ${DB_PASSWORD}"

# ── Step 12: Directory structure + .env ──────────────────────────
echo ""
echo "▸ Step 12/15: Creating directory structure..."

mkdir -p /var/www/scws/{daemon/dist,projects,nginx/projects,scripts,logs}

# Set ownership to SCWS_USER (daemon runs as non-root)
chown -R "${SCWS_USER}:${SCWS_USER}" /var/www/scws

# Daemon .env
cat > /var/www/scws/daemon/.env << EOF
DATABASE_URL=postgresql://scws:${DB_PASSWORD}@localhost:5432/scws_daemon
PORT=4000
DASHBOARD_TOKEN=${DASHBOARD_TOKEN}
SCWS_DB_PASSWORD=${DB_PASSWORD}
SCWS_BASE_URL=http://${TAILSCALE_IP}
NODE_ENV=production
EOF

chmod 600 /var/www/scws/daemon/.env
chown "${SCWS_USER}:${SCWS_USER}" /var/www/scws/daemon/.env

echo "  ✓ Directory structure created"

# ── Step 13: nginx (HTTP only, Tailscale) ─────────────────────────
echo ""
echo "▸ Step 13/15: Configuring nginx..."

cat > /etc/nginx/sites-available/scws << NGINX
server {
    listen 80;
    server_name ${TAILSCALE_IP} ${TAILSCALE_HOSTNAME};

    # SCWS dashboard at root
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # Per-project configs
    include /var/www/scws/nginx/projects/*.conf;
}
NGINX

ln -sf /etc/nginx/sites-available/scws /etc/nginx/sites-enabled/scws
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

echo "  ✓ nginx configured (HTTP only, Tailscale access)"

# ── Step 14: Sudoers + PM2 ──────────────────────────────────────
echo ""
echo "▸ Step 14/15: Configuring sudoers + PM2..."

cat > /etc/sudoers.d/scws << EOF
# SPAWN — full passwordless sudo for dev Pi (Tailscale-only access)
${SCWS_USER} ALL=(ALL) NOPASSWD: ALL
EOF

chmod 440 /etc/sudoers.d/scws

echo "  ✓ Sudoers configured for ${SCWS_USER}"

su - "${SCWS_USER}" -c "pm2 startup systemd -u ${SCWS_USER} --hp ${SCWS_HOME}" 2>/dev/null || true
# The above prints a command to run as root — capture and execute it
PM2_STARTUP_CMD=$(su - "${SCWS_USER}" -c "pm2 startup systemd -u ${SCWS_USER} --hp ${SCWS_HOME}" 2>&1 | grep "sudo env" || true)
if [ -n "$PM2_STARTUP_CMD" ]; then
  eval "$PM2_STARTUP_CMD" 2>/dev/null || true
fi

echo "  ✓ PM2 configured for startup as ${SCWS_USER}"

# ── Step 15: Cron jobs (healthcheck + DuckDNS) ──────────────────
echo ""
echo "▸ Step 15/15: Setting up cron jobs..."

# Copy healthcheck script
cp "$(dirname "$0")/healthcheck.sh" /var/www/scws/scripts/healthcheck.sh 2>/dev/null || true
chmod +x /var/www/scws/scripts/healthcheck.sh 2>/dev/null || true
chown "${SCWS_USER}:${SCWS_USER}" /var/www/scws/scripts/healthcheck.sh 2>/dev/null || true

# Healthcheck cron — every 5 minutes
HEALTH_CRON="*/5 * * * * /var/www/scws/scripts/healthcheck.sh"
(su - "${SCWS_USER}" -c "crontab -l 2>/dev/null" || true) | grep -qF "healthcheck.sh" || \
  (su - "${SCWS_USER}" -c "crontab -l 2>/dev/null" || true; echo "${HEALTH_CRON}") | su - "${SCWS_USER}" -c "crontab -"

echo "  ✓ Healthcheck cron installed (every 5 minutes)"

# DuckDNS dynamic DNS (optional)
if [ -n "${DUCKDNS_DOMAIN}" ] && [ -n "${DUCKDNS_TOKEN}" ]; then
  cat > /var/www/scws/scripts/duckdns-update.sh << DUCKDNS
#!/bin/bash
echo url="https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=" | curl -k -o /var/www/scws/logs/duckdns.log -K -
DUCKDNS
  chmod +x /var/www/scws/scripts/duckdns-update.sh
  chown "${SCWS_USER}:${SCWS_USER}" /var/www/scws/scripts/duckdns-update.sh

  DUCKDNS_CRON="*/5 * * * * /var/www/scws/scripts/duckdns-update.sh"
  (su - "${SCWS_USER}" -c "crontab -l 2>/dev/null" || true) | grep -qF "duckdns-update.sh" || \
    (su - "${SCWS_USER}" -c "crontab -l 2>/dev/null" || true; echo "${DUCKDNS_CRON}") | su - "${SCWS_USER}" -c "crontab -"

  echo "  ✓ DuckDNS cron installed (domain: ${DUCKDNS_DOMAIN})"
else
  echo "  ⊘ DuckDNS skipped (DUCKDNS_DOMAIN/DUCKDNS_TOKEN not set)"
fi

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  SPAWN Bootstrap Complete! (Raspberry Pi 5)"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Tailscale IP:  ${TAILSCALE_IP}"
echo "  Hostname:      ${TAILSCALE_HOSTNAME}"
echo "  Dashboard:     http://${TAILSCALE_IP}"
echo "  DB User:       scws"
echo "  DB Pass:       ${DB_PASSWORD}"
echo "  Token:         ${DASHBOARD_TOKEN}"
echo "  Run-as user:   ${SCWS_USER}"
echo ""
echo "  Installed:"
echo "    nginx, PostgreSQL 16, fail2ban, Tailscale"
echo "    Node.js 20, PM2, TypeScript, tsx, esbuild"
echo "    Claude CLI, GitHub CLI"
echo "    Docker CE, Redis, Go"
echo "    ffmpeg, ImageMagick, ripgrep, chromium"
echo "    GPIO libs (libgpiod, i2c-tools)"
echo ""
echo "  Database: 6 tables (projects, claude_runs, activity_log,"
echo "    daemon_config, channels, notifications)"
echo ""
echo "  Cron: healthcheck (5min)$([ -n "${DUCKDNS_DOMAIN}" ] && echo ", DuckDNS (5min)")"
echo ""
echo "  Next steps:"
echo "  1. Build on Windows:   npx tsx script/build.ts"
echo "  2. Deploy daemon:      scp dist/* ${SCWS_USER}@${TAILSCALE_IP}:/var/www/scws/daemon/dist/"
echo "  3. Copy package.json:  scp package.json ${SCWS_USER}@${TAILSCALE_IP}:/var/www/scws/daemon/"
echo "  4. Install on Pi:      cd /var/www/scws/daemon && npm install --omit=dev"
echo "  5. Start daemon:       pm2 start dist/index.cjs --name scws-daemon"
echo "  6. Save PM2:           pm2 save"
echo "  7. Auth Claude CLI:    claude  (interactive, one-time)"
echo "  8. Auth GitHub CLI:    gh auth login  (interactive, one-time)"
echo ""
echo "  SAVE THIS OUTPUT — it contains your DB password!"
echo "═══════════════════════════════════════════════════════"
