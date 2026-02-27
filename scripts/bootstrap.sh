#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════
# SCWS Bootstrap Script — Self Coding Web Server
# Provisions a fresh Ubuntu 24.04 VPS into a full dev + hosting server
# ═══════════════════════════════════════════════════════════════════

# ── Configuration (edit these before running) ─────────────────────

DUCKDNS_DOMAIN="scws"
DUCKDNS_TOKEN="93efc674-6dc6-4bac-a4aa-22b22bf3f416"
CERTBOT_EMAIL="billycarr007@gmail.com"
DASHBOARD_TOKEN="b3089956e81b8b8c11979d66b8e31776178f67d79da18a5670374810433d2ad1"
DB_PASSWORD="scws_$(openssl rand -hex 8)"
MCP_SERVER_URL="https://passoncloud.duckdns.org/mcp"
MCP_SERVER_TOKEN="2c86de7bd448b5f21614599cae27ceccdca921756ec2f8d1ed3e4c8a8e178ce8"

if [ -z "$DUCKDNS_TOKEN" ] || [ -z "$CERTBOT_EMAIL" ] || [ -z "$DASHBOARD_TOKEN" ]; then
  echo "ERROR: Edit this script and fill in DUCKDNS_TOKEN, CERTBOT_EMAIL, and DASHBOARD_TOKEN"
  exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  SCWS Bootstrap — Starting VPS provisioning"
echo "═══════════════════════════════════════════════════════"

# ── Step 1: System packages ───────────────────────────────────────
echo ""
echo "▸ Step 1/12: Installing system packages..."

apt update && apt upgrade -y
apt install -y \
  nginx postgresql postgresql-contrib fail2ban ufw \
  curl wget git build-essential \
  python3 python3-pip python3-venv \
  jq htop tmux unzip certbot python3-certbot-nginx \
  software-properties-common

echo "  ✓ System packages installed"

# ── Step 2: Firewall ──────────────────────────────────────────────
echo ""
echo "▸ Step 2/12: Configuring firewall..."

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "  ✓ Firewall configured (22, 80, 443)"

# ── Step 3: fail2ban ──────────────────────────────────────────────
echo ""
echo "▸ Step 3/12: Configuring fail2ban..."

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

# ── Step 4: Node.js 20 ───────────────────────────────────────────
echo ""
echo "▸ Step 4/12: Installing Node.js 20..."

if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "  Node.js $(node --version)"
echo "  npm $(npm --version)"
echo "  ✓ Node.js installed"

# ── Step 5: Global npm tools ─────────────────────────────────────
echo ""
echo "▸ Step 5/12: Installing global npm tools..."

npm install -g pm2 typescript tsx esbuild

echo "  ✓ PM2, TypeScript, tsx, esbuild installed globally"

# ── Step 6: Claude CLI ───────────────────────────────────────────
echo ""
echo "▸ Step 6/12: Installing Claude CLI..."

if ! command -v claude &>/dev/null; then
  curl -fsSL https://claude.ai/install.sh | bash
  # Add to PATH for current session
  export PATH="$HOME/.claude/bin:$PATH"
fi

echo "  ✓ Claude CLI installed"
echo "  NOTE: Run 'claude' interactively after bootstrap to authenticate with Claude Max"

# ── Step 7: Claude CLI MCP Server Config ─────────────────────────
echo ""
echo "▸ Step 7/12: Configuring Claude CLI MCP server connection..."

mkdir -p /root/.claude

cat > /root/.claude/settings.json << EOF
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

echo "  ✓ Claude CLI configured with MCP server at ${MCP_SERVER_URL}"

# ── Step 8: GitHub CLI ───────────────────────────────────────────
echo ""
echo "▸ Step 8/12: Installing GitHub CLI..."

if ! command -v gh &>/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  apt update && apt install -y gh
fi

echo "  ✓ GitHub CLI installed"
echo "  NOTE: Run 'gh auth login' after bootstrap to authenticate"

# ── Step 9: PostgreSQL ───────────────────────────────────────────
echo ""
echo "▸ Step 9/12: Configuring PostgreSQL..."

systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='scws'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER scws WITH PASSWORD '${DB_PASSWORD}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='scws_daemon'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE scws_daemon OWNER scws;"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE scws_daemon TO scws;"

echo "  ✓ PostgreSQL configured (user: scws, db: scws_daemon)"
echo "  DB Password: ${DB_PASSWORD}"

# ── Step 10: Directory structure ─────────────────────────────────
echo ""
echo "▸ Step 10/12: Creating directory structure..."

mkdir -p /var/www/scws/{daemon/dist,projects,nginx/projects,duckdns,scripts,logs}

# Daemon .env
cat > /var/www/scws/daemon/.env << EOF
DATABASE_URL=postgresql://scws:${DB_PASSWORD}@localhost:5432/scws_daemon
PORT=4000
DASHBOARD_TOKEN=${DASHBOARD_TOKEN}
SCWS_DB_PASSWORD=${DB_PASSWORD}
NODE_ENV=production
EOF

chmod 600 /var/www/scws/daemon/.env

echo "  ✓ Directory structure created"

# ── Step 11: DuckDNS + Let's Encrypt ─────────────────────────────
echo ""
echo "▸ Step 11/12: Setting up DuckDNS and SSL..."

# DuckDNS update script
cat > /var/www/scws/duckdns/update.sh << EOF
#!/bin/bash
echo url="https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=" | curl -s -o /var/www/scws/duckdns/duck.log -K -
EOF
chmod +x /var/www/scws/duckdns/update.sh

# Run once to set IP
/var/www/scws/duckdns/update.sh

# Add cron for DuckDNS
(crontab -l 2>/dev/null | grep -v "duckdns" ; echo "*/5 * * * * /var/www/scws/duckdns/update.sh >/dev/null 2>&1") | crontab -

echo "  ✓ DuckDNS configured (${DUCKDNS_DOMAIN}.duckdns.org)"

# nginx config (HTTP first, certbot adds SSL)
cat > /etc/nginx/sites-available/scws << 'NGINX'
server {
    listen 80;
    server_name scws.duckdns.org;

    # SCWS dashboard at root
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Per-project configs
    include /var/www/scws/nginx/projects/*.conf;
}
NGINX

# Enable site
ln -sf /etc/nginx/sites-available/scws /etc/nginx/sites-enabled/scws
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

# Let's Encrypt SSL (will modify nginx config in-place)
echo "  Requesting SSL certificate..."
certbot --nginx -d ${DUCKDNS_DOMAIN}.duckdns.org \
  --non-interactive --agree-tos -m ${CERTBOT_EMAIL} \
  --redirect

# Auto-renewal cron
(crontab -l 2>/dev/null | grep -v "certbot" ; echo "0 3 * * * certbot renew --quiet") | crontab -

echo "  ✓ SSL certificate configured"

# ── Step 12: PM2 setup ───────────────────────────────────────────
echo ""
echo "▸ Step 12/12: Setting up PM2..."

# PM2 startup script
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo "  ✓ PM2 configured for startup"

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  SCWS Bootstrap Complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Domain:     https://${DUCKDNS_DOMAIN}.duckdns.org"
echo "  Dashboard:  https://${DUCKDNS_DOMAIN}.duckdns.org"
echo "  DB User:    scws"
echo "  DB Pass:    ${DB_PASSWORD}"
echo "  Token:      ${DASHBOARD_TOKEN}"
echo ""
echo "  Next steps:"
echo "  1. Deploy the daemon:  scp dist/* root@<IP>:/var/www/scws/daemon/dist/"
echo "  2. Start daemon:       cd /var/www/scws/daemon && pm2 start dist/index.cjs --name scws-daemon"
echo "  3. Save PM2:           pm2 save"
echo "  4. Auth Claude CLI:    claude  (interactive, one-time)"
echo "  5. Auth GitHub CLI:    gh auth login  (interactive, one-time)"
echo ""
echo "  SAVE THIS OUTPUT — it contains your DB password!"
echo "═══════════════════════════════════════════════════════"
