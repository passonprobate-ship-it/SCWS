#!/usr/bin/env bash
# =============================================================================
# SPAWN VPS Bootstrap — Self-Programming Autonomous Web Node
# =============================================================================
# Adapted from the Pi 5 bootstrap for generic Linux VPS (Ubuntu 24.04).
# Removes all Pi-specific hardware (GPIO, I2C, SPI, pinctrl, Chromium).
# Auto-detects architecture (amd64/arm64) for APT repos.
#
# This script runs ON the VPS as root. It's typically invoked by deploy.sh
# from the Pi, but can also be run manually:
#
#   sudo bash bootstrap-vps.sh
#
# Environment variables (set by deploy.sh or export before running):
#   SPAWN_USER          - Linux user to create/use (default: spawn)
#   SPAWN_HOSTNAME      - Hostname (default: SPAWN)
#   SPAWN_DOMAIN        - Public domain (empty = IP only)
#   SPAWN_DB_PASSWORD   - PostgreSQL password for 'scws' role (required)
#   ENABLE_SSL          - true/false (default: false)
#   SSL_EMAIL           - Email for Let's Encrypt (required if SSL=true)
#   ENABLE_TAILSCALE    - true/false (default: false)
#   INSTALL_DOCKER      - true/false (default: false)
# =============================================================================
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SPAWN_USER="${SPAWN_USER:-spawn}"
SPAWN_HOSTNAME="${SPAWN_HOSTNAME:-SPAWN}"
SPAWN_DOMAIN="${SPAWN_DOMAIN:-}"
SPAWN_DB_PASSWORD="${SPAWN_DB_PASSWORD:-}"
ENABLE_SSL="${ENABLE_SSL:-false}"
SSL_EMAIL="${SSL_EMAIL:-}"
ENABLE_TAILSCALE="${ENABLE_TAILSCALE:-false}"
INSTALL_DOCKER="${INSTALL_DOCKER:-false}"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[SPAWN]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (or via sudo)."
  exit 1
fi

if [[ -z "$SPAWN_DB_PASSWORD" ]]; then
  err "SPAWN_DB_PASSWORD is required. Set it before running."
  exit 1
fi

ARCH=$(dpkg --print-architecture)
log "Starting SPAWN VPS bootstrap on $(hostname) — arch=$ARCH — $(date)"

# ── Memory detection for scaling ──────────────────────────────────────────────
RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
log "Detected ${RAM_MB}MB RAM"

if   (( RAM_MB < 1024 )); then
  SWAP_SIZE="1G"; PG_CONNS=15; DAEMON_HEAP=96; PM2_RESTART="128M"
elif (( RAM_MB < 2048 )); then
  SWAP_SIZE="1G"; PG_CONNS=20; DAEMON_HEAP=128; PM2_RESTART="160M"
elif (( RAM_MB < 4096 )); then
  SWAP_SIZE="2G"; PG_CONNS=30; DAEMON_HEAP=192; PM2_RESTART="200M"
elif (( RAM_MB < 8192 )); then
  SWAP_SIZE="4G"; PG_CONNS=40; DAEMON_HEAP=192; PM2_RESTART="200M"
else
  SWAP_SIZE="4G"; PG_CONNS=50; DAEMON_HEAP=256; PM2_RESTART="300M"
fi

log "Scaling: swap=${SWAP_SIZE} pg_conns=${PG_CONNS} heap=${DAEMON_HEAP}MB restart=${PM2_RESTART}"

# ── 1. Hostname ───────────────────────────────────────────────────────────────
log "Setting hostname to ${SPAWN_HOSTNAME}..."
hostnamectl set-hostname "$SPAWN_HOSTNAME"
# Ensure new hostname resolves locally (cloud-init may manage /etc/hosts with old name)
if ! grep -q "127.0.1.1.*${SPAWN_HOSTNAME}" /etc/hosts 2>/dev/null; then
  sed -i "/127.0.1.1/d" /etc/hosts
  echo "127.0.1.1 ${SPAWN_HOSTNAME}" >> /etc/hosts
fi

# ── 2. Create user + sudoers ──────────────────────────────────────────────────
if ! id "$SPAWN_USER" &>/dev/null; then
  log "Creating user '$SPAWN_USER'..."
  useradd -m -s /bin/bash "$SPAWN_USER"
  # Copy root's authorized_keys so SSH still works
  if [[ -f /root/.ssh/authorized_keys ]]; then
    mkdir -p "/home/$SPAWN_USER/.ssh"
    cp /root/.ssh/authorized_keys "/home/$SPAWN_USER/.ssh/"
    chown -R "$SPAWN_USER:$SPAWN_USER" "/home/$SPAWN_USER/.ssh"
    chmod 700 "/home/$SPAWN_USER/.ssh"
    chmod 600 "/home/$SPAWN_USER/.ssh/authorized_keys"
  fi
else
  log "User '$SPAWN_USER' already exists."
fi

log "Configuring sudoers..."
echo "$SPAWN_USER ALL=(ALL) NOPASSWD: ALL" > "/etc/sudoers.d/$SPAWN_USER"
chmod 440 "/etc/sudoers.d/$SPAWN_USER"

# ── 3. User groups (no GPIO/I2C/SPI on VPS) ──────────────────────────────────
log "Setting up user groups..."
usermod -aG sudo,adm "$SPAWN_USER" 2>/dev/null || true

# ── 4. APT repositories ──────────────────────────────────────────────────────
log "Adding APT repositories (arch=$ARCH)..."

# Detect Ubuntu codename for APT repos
UBUNTU_CODENAME=$(lsb_release -cs 2>/dev/null || source /etc/os-release && echo "${VERSION_CODENAME:-noble}")

# NodeSource (Node.js 20.x)
mkdir -p /usr/share/keyrings
if [[ ! -f /usr/share/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
fi
cat > /etc/apt/sources.list.d/nodesource.sources <<APTEOF
Types: deb
URIs: https://deb.nodesource.com/node_20.x
Suites: nodistro
Components: main
Architectures: ${ARCH}
Signed-By: /usr/share/keyrings/nodesource.gpg
APTEOF

# GitHub CLI
if [[ ! -f /usr/share/keyrings/githubcli-archive-keyring.gpg ]]; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
fi
echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list

# Tailscale (conditional)
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  if [[ ! -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${UBUNTU_CODENAME}.noarmor.gpg" \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  fi
  echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu ${UBUNTU_CODENAME} main" \
    > /etc/apt/sources.list.d/tailscale.list
fi

# Docker (conditional)
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  mkdir -p /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
fi

# ── 5. System packages ───────────────────────────────────────────────────────
log "Updating and installing system packages..."
apt-get update -qq

# Base packages (no GPIO/I2C/Chromium)
apt-get install -y -qq \
  nodejs \
  postgresql postgresql-contrib \
  redis-server \
  nginx \
  gh \
  git \
  build-essential \
  python3 python3-pip python3-venv \
  golang-go \
  cmake \
  imagemagick \
  ffmpeg \
  jq yq \
  ripgrep \
  libcap2-bin \
  fail2ban \
  ufw \
  sqlite3 \
  curl wget \
  unzip \
  htop \
  tree

# Conditional packages
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  apt-get install -y -qq tailscale
fi

if [[ "$INSTALL_DOCKER" == "true" ]]; then
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  usermod -aG docker "$SPAWN_USER"
fi

# ── 6. Node.js global packages ───────────────────────────────────────────────
log "Installing global npm packages..."
npm install -g \
  pm2@latest \
  typescript \
  tsx \
  esbuild

# ── 7. PM2 log rotation ──────────────────────────────────────────────────────
log "Installing and configuring pm2-logrotate..."
sudo -u "$SPAWN_USER" pm2 install pm2-logrotate
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:max_size 10M
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:retain 5
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:compress true
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:rotateInterval "0 0 * * *"
sudo -u "$SPAWN_USER" pm2 set pm2-logrotate:rotateModule true

# ── 8. PM2 startup hook ──────────────────────────────────────────────────────
log "Configuring PM2 startup..."
env PATH=$PATH:/usr/bin pm2 startup systemd -u "$SPAWN_USER" --hp "/home/$SPAWN_USER" --no-daemon
systemctl enable "pm2-${SPAWN_USER}"

# ── 9. Bun ────────────────────────────────────────────────────────────────────
log "Installing Bun..."
sudo -u "$SPAWN_USER" bash -c 'curl -fsSL https://bun.sh/install | bash'

# ── 10. PostgreSQL setup ──────────────────────────────────────────────────────
log "Configuring PostgreSQL..."
systemctl enable --now postgresql

# Create the scws role
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='scws'" | grep -q 1; then
  log "Creating PostgreSQL role 'scws'..."
  sudo -u postgres psql -c "CREATE ROLE scws WITH LOGIN PASSWORD '${SPAWN_DB_PASSWORD}';"
else
  log "PostgreSQL role 'scws' already exists."
fi

# Create main database
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='scws_daemon'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE DATABASE scws_daemon OWNER scws;"
  log "Created database: scws_daemon"
else
  log "Database scws_daemon already exists."
fi

# ── 11. Directory structure ───────────────────────────────────────────────────
log "Creating SPAWN directory structure..."
mkdir -p /var/www/scws/{daemon/dist,projects,nginx/projects,scripts,logs,backups}
chown -R "$SPAWN_USER:$SPAWN_USER" /var/www/scws

# ── 12. Swap ──────────────────────────────────────────────────────────────────
log "Configuring ${SWAP_SIZE} swap..."
if [[ ! -f /swapfile ]]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "${SWAP_SIZE} swapfile created and activated."
else
  log "Swapfile already exists."
fi

# ── 13. Kernel tuning ────────────────────────────────────────────────────────
log "Applying kernel tuning..."
cat > /etc/sysctl.d/99-spawn-memory.conf <<'SYSEOF'
vm.swappiness=5
vm.vfs_cache_pressure=50
SYSEOF
sysctl --system >/dev/null 2>&1

# ── 14. Nginx configuration ──────────────────────────────────────────────────
log "Configuring nginx..."

# Build server_name directive
SERVER_NAMES=""
if [[ -n "$SPAWN_DOMAIN" ]]; then
  SERVER_NAMES="$SPAWN_DOMAIN"
fi
# Try to detect the VPS's public IP
VPS_PUBLIC_IP=$(curl -s --max-time 5 http://ifconfig.me 2>/dev/null || true)
if [[ -n "$VPS_PUBLIC_IP" ]]; then
  SERVER_NAMES="${SERVER_NAMES:+$SERVER_NAMES }${VPS_PUBLIC_IP}"
fi
SERVER_NAMES="${SERVER_NAMES:+$SERVER_NAMES }_"

rm -f /etc/nginx/sites-enabled/default

cat > /etc/nginx/sites-available/scws <<NGINXEOF
server {
    listen 80;
    server_name ${SERVER_NAMES};

    client_max_body_size 150m;

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

    include /var/www/scws/nginx/projects/*.conf;

    location @project_down {
        default_type application/json;
        return 503 '{"error":"Service unavailable","message":"This project is not running. Start it from the SPAWN dashboard."}';
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/scws /etc/nginx/sites-enabled/scws
nginx -t && systemctl reload nginx
systemctl enable nginx

# ── 15. UFW firewall ──────────────────────────────────────────────────────────
log "Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
if [[ "$ENABLE_SSL" == "true" ]]; then
  ufw allow 443/tcp
fi
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  ufw allow in on tailscale0 2>/dev/null || true
fi
ufw --force enable
systemctl enable ufw

# ── 16. Fail2ban ──────────────────────────────────────────────────────────────
log "Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'F2BEOF'
[DEFAULT]
bantime = 1800
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = %(sshd_log)s
F2BEOF
systemctl enable fail2ban
systemctl restart fail2ban || warn "fail2ban failed to start — check logs."

# ── 17. Backup script + cron ─────────────────────────────────────────────────
log "Installing backup cron job..."
# backup-db.sh is deployed separately by deploy.sh
CRON_LOCAL="0 2 * * * /var/www/scws/scripts/backup-db.sh >> /var/www/scws/logs/backup.log 2>&1"
EXISTING_CRON=$(sudo -u "$SPAWN_USER" crontab -l 2>/dev/null | grep -v 'backup-db.sh' || true)
printf '%s\n%s\n' "$EXISTING_CRON" "$CRON_LOCAL" | sudo -u "$SPAWN_USER" crontab -

# ── 18. Shell profile ────────────────────────────────────────────────────────
log "Configuring shell profile..."
PROFILE="/home/$SPAWN_USER/.profile"
BASHRC="/home/$SPAWN_USER/.bashrc"

if ! grep -q 'BUN_INSTALL' "$PROFILE" 2>/dev/null; then
  cat >> "$PROFILE" <<PROFILEEOF

# Bun
export PATH="/home/${SPAWN_USER}/.bun/bin:\$PATH"
PROFILEEOF
fi

if ! grep -q 'BUN_INSTALL' "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" <<BASHRCEOF

# Bun
export BUN_INSTALL="\$HOME/.bun"
export PATH="\$BUN_INSTALL/bin:\$PATH"
BASHRCEOF
fi

chown "$SPAWN_USER:$SPAWN_USER" "$PROFILE" "$BASHRC"

# ── 19. OOM killer prioritization ────────────────────────────────────────────
log "Configuring OOM killer priorities..."

mkdir -p "/etc/systemd/system/pm2-${SPAWN_USER}.service.d"
cat > "/etc/systemd/system/pm2-${SPAWN_USER}.service.d/oom.conf" <<'OOMEOF'
[Service]
OOMScoreAdjust=-800
OOMEOF
systemctl daemon-reload

# ── 20. Docker disable at boot (if installed) ────────────────────────────────
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  log "Disabling Docker at boot (saves RAM, start on demand)..."
  systemctl disable docker.service docker.socket containerd.service 2>/dev/null || true
  systemctl stop docker.service containerd.service 2>/dev/null || true
fi

# ── 21. PostgreSQL tuning ────────────────────────────────────────────────────
log "Tuning PostgreSQL (max_connections=${PG_CONNS})..."
PG_CONF=$(find /etc/postgresql -name postgresql.conf -type f 2>/dev/null | head -1)
if [[ -n "$PG_CONF" ]]; then
  sed -i "s/^max_connections = .*/max_connections = ${PG_CONNS}/" "$PG_CONF"
  systemctl restart postgresql
fi

# ── 22. SSL (conditional) ────────────────────────────────────────────────────
if [[ "$ENABLE_SSL" == "true" && -n "$SPAWN_DOMAIN" ]]; then
  log "Setting up SSL with Let's Encrypt..."
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$SPAWN_DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect
  log "SSL certificate installed for $SPAWN_DOMAIN"
fi

# ── 23. File ownership sweep ─────────────────────────────────────────────────
log "Final ownership sweep..."
chown -R "$SPAWN_USER:$SPAWN_USER" /var/www/scws

# ── 24. Export scaling values for deploy.sh to use ────────────────────────────
# Write computed values so deploy.sh can read them for template substitution
cat > /tmp/spawn-bootstrap-values <<VALEOF
DAEMON_HEAP=${DAEMON_HEAP}
PM2_RESTART=${PM2_RESTART}
VALEOF

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
log "============================================"
log "  SPAWN VPS bootstrap complete!"
log "============================================"
echo ""
log "Installed:"
log "  Node.js $(node --version), npm $(npm --version)"
log "  PostgreSQL $(psql --version | awk '{print $3}')"
log "  Redis $(redis-server --version | awk '{print $3}' | tr -d 'v=')"
log "  nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"
if [[ "$INSTALL_DOCKER" == "true" ]]; then
  log "  Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
fi
log "  PM2 $(pm2 --version 2>/dev/null)"
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  log "  Tailscale $(tailscale version 2>/dev/null | head -1)"
fi
echo ""
log "Memory scaling: heap=${DAEMON_HEAP}MB restart=${PM2_RESTART} pg_conns=${PG_CONNS} swap=${SWAP_SIZE}"
log "Ports: daemon=4000, projects=5001-5099"
echo ""
if [[ "$ENABLE_TAILSCALE" == "true" ]]; then
  log "Next: sudo tailscale up --hostname=${SPAWN_HOSTNAME}"
fi
