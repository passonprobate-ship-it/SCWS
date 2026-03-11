#!/usr/bin/env bash
# seed-examples.sh — Install example projects into a fresh SPAWN instance
# Called by install.sh after daemon is running and API is accessible.
#
# Usage: bash scripts/seed-examples.sh [DASHBOARD_TOKEN] [SPAWN_USER]
# If args not provided, reads from daemon/.env and defaults to codeman.

set -euo pipefail

SCWS_ROOT="/var/www/scws"
EXAMPLES_DIR="$SCWS_ROOT/examples"
PROJECTS_DIR="$SCWS_ROOT/projects"
NGINX_DIR="$SCWS_ROOT/nginx/projects"

TOKEN="${1:-}"
SPAWN_USER="${2:-codeman}"

# If no token passed, try to read from daemon .env
if [[ -z "$TOKEN" ]]; then
  TOKEN=$(grep '^DASHBOARD_TOKEN=' "$SCWS_ROOT/daemon/.env" 2>/dev/null | cut -d= -f2 || true)
fi

if [[ -z "$TOKEN" ]]; then
  echo "[seed] ERROR: No DASHBOARD_TOKEN available — cannot register projects"
  exit 1
fi

# Detect Raspberry Pi
IS_PI=false
if [[ -f /proc/device-tree/model ]]; then
  DT_MODEL=$(tr -d '\0' < /proc/device-tree/model)
  if echo "$DT_MODEL" | grep -qi "raspberry pi"; then
    IS_PI=true
  fi
fi

# Wait for daemon API
for i in 1 2 3 4 5; do
  curl -sf http://localhost:4000/health >/dev/null 2>&1 && break
  sleep 2
done

if ! curl -sf http://localhost:4000/health >/dev/null 2>&1; then
  echo "[seed] ERROR: Daemon not responding at localhost:4000"
  exit 1
fi

API="http://localhost:4000/api"
AUTH="Authorization: Bearer $TOKEN"

# Get the DB password from daemon .env for webhook-catcher
DB_PASSWORD=$(grep '^DATABASE_URL=' "$SCWS_ROOT/daemon/.env" 2>/dev/null | sed 's|.*://scws:\([^@]*\)@.*|\1|' || true)

installed=0
skipped=0

install_example() {
  local name="$1"
  local display_name="$2"
  local description="$3"
  local framework="${4:-express}"
  local needs_db="${5:-false}"
  local heap_mb="${6:-256}"

  # Skip if project already exists
  local exists
  exists=$(curl -sf -H "$AUTH" "$API/projects/$name" 2>/dev/null | grep -c '"name"' || true)
  if [[ "$exists" -gt 0 ]]; then
    echo "[seed] $name — already exists, skipping"
    skipped=$((skipped + 1))
    return 0
  fi

  # Skip if directory already has content
  if [[ -d "$PROJECTS_DIR/$name" && "$(ls -A "$PROJECTS_DIR/$name" 2>/dev/null)" ]]; then
    echo "[seed] $name — directory exists with content, skipping"
    skipped=$((skipped + 1))
    return 0
  fi

  echo "[seed] Installing $name..."

  # Copy example files
  mkdir -p "$PROJECTS_DIR/$name"
  cp -r "$EXAMPLES_DIR/$name/"* "$PROJECTS_DIR/$name/"
  cp -r "$EXAMPLES_DIR/$name/".[!.]* "$PROJECTS_DIR/$name/" 2>/dev/null || true

  # Get next available port from daemon
  local port
  port=$(curl -sf -H "$AUTH" "$API/projects" 2>/dev/null | \
    python3 -c "import sys,json; ports=[p.get('port',0) for p in json.load(sys.stdin)]; print(max(ports)+1 if ports else 5001)" 2>/dev/null || echo "5001")

  # Create .env from .env.example
  if [[ -f "$PROJECTS_DIR/$name/.env.example" ]]; then
    sed "s|^PORT=.*|PORT=$port|" "$PROJECTS_DIR/$name/.env.example" | \
      sed "s|^BASE_URL=.*|BASE_URL=/$name|" > "$PROJECTS_DIR/$name/.env"

    # Inject real DATABASE_URL for DB projects
    if [[ "$needs_db" == "true" && -n "$DB_PASSWORD" ]]; then
      local db_name="${name//-/_}_db"
      # Create database
      sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$db_name'" 2>/dev/null | grep -q 1 || \
        sudo -u postgres psql -c "CREATE DATABASE $db_name OWNER scws;" 2>/dev/null || true
      sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://scws:${DB_PASSWORD}@localhost:5432/${db_name}|" "$PROJECTS_DIR/$name/.env"
    fi

    # Inject DASHBOARD_TOKEN if needed
    if grep -q 'DASHBOARD_TOKEN' "$PROJECTS_DIR/$name/.env.example" 2>/dev/null; then
      echo "DASHBOARD_TOKEN=$TOKEN" >> "$PROJECTS_DIR/$name/.env"
    fi

    chmod 600 "$PROJECTS_DIR/$name/.env"
  else
    # Create minimal .env
    printf "PORT=%s\nBASE_URL=/%s\nNODE_ENV=production\n" "$port" "$name" > "$PROJECTS_DIR/$name/.env"
    chmod 600 "$PROJECTS_DIR/$name/.env"
  fi

  # npm install (skip for static sites)
  if [[ "$framework" != "static" && -f "$PROJECTS_DIR/$name/package.json" ]]; then
    echo "[seed]   npm install..."
    cd "$PROJECTS_DIR/$name"
    # Install all deps (including devDependencies for build step)
    NODE_OPTIONS="--max-old-space-size=512" npm install --no-audit --no-fund 2>&1 | tail -2

    # Build if build script exists
    local has_build
    has_build=$(grep -c '"build"' "$PROJECTS_DIR/$name/package.json" || true)
    if [[ "$has_build" -gt 0 ]]; then
      echo "[seed]   Building..."
      npm run build 2>&1 | tail -2
    fi

    # Prune devDependencies after build to save disk
    npm prune --omit=dev --no-audit --no-fund 2>&1 | tail -1
  fi

  # Fix ownership
  chown -R "${SPAWN_USER}:${SPAWN_USER}" "$PROJECTS_DIR/$name"

  # Start with PM2 (skip for static sites)
  if [[ "$framework" != "static" ]]; then
    local entry="dist/index.js"
    # Detect entry file
    if [[ -f "$PROJECTS_DIR/$name/dist/index.cjs" ]]; then
      entry="dist/index.cjs"
    elif [[ -f "$PROJECTS_DIR/$name/dist/index.js" ]]; then
      entry="dist/index.js"
    elif [[ -f "$PROJECTS_DIR/$name/index.js" ]]; then
      entry="index.js"
    fi

    sudo -u "$SPAWN_USER" pm2 start "$PROJECTS_DIR/$name/$entry" \
      --name "$name" \
      --cwd "$PROJECTS_DIR/$name" \
      --node-args="--env-file=.env --max-old-space-size=$heap_mb" \
      --max-memory-restart "${heap_mb}M" 2>&1 | tail -1
  fi

  # Write nginx config
  if [[ "$framework" == "static" ]]; then
    cat > "$NGINX_DIR/$name.conf" <<NGINXEOF
location /$name/ {
    alias $PROJECTS_DIR/$name/;
    index index.html;
    try_files \$uri \$uri/ /index.html;
}
NGINXEOF
  else
    cat > "$NGINX_DIR/$name.conf" <<NGINXEOF
location /$name/ {
    proxy_pass http://127.0.0.1:$port/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 86400;
    proxy_intercept_errors on;
    error_page 502 503 504 = @project_down;
}
NGINXEOF
  fi

  # Register in daemon via API
  curl -sf -X POST "$API/projects" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"name":"%s","displayName":"%s","framework":"%s","description":"%s"}' \
      "$name" "$display_name" "$framework" "$description")" >/dev/null 2>&1 || true

  # Set status and port
  local status="running"
  [[ "$framework" == "static" ]] && status="running"
  curl -sf -X PATCH "$API/projects/$name" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"status":"%s"}' "$status")" >/dev/null 2>&1 || true

  echo "[seed]   $name installed (port $port)"
  installed=$((installed + 1))
}

# ── Install example projects ──────────────────────────────────────────────

echo "[seed] Seeding example projects..."

# 1. hello-spawn — everyone gets this
if [[ -d "$EXAMPLES_DIR/hello-spawn" ]]; then
  install_example "hello-spawn" "Hello SPAWN" \
    "Interactive API demo with live endpoint explorer" \
    "express" "false" "192"
fi

# 2. static-site — everyone gets this
if [[ -d "$EXAMPLES_DIR/static-site" ]]; then
  install_example "static-site" "Static Site" \
    "Beautiful portfolio template — zero build step, pure HTML/CSS" \
    "static" "false" "0"
fi

# 3. big-pickle — everyone gets this
if [[ -d "$EXAMPLES_DIR/big-pickle" ]]; then
  install_example "big-pickle" "Big Pickle" \
    "SPAWN portfolio page with live system stats" \
    "express" "false" "192"
fi

# 4. webhook-catcher — everyone gets this
if [[ -d "$EXAMPLES_DIR/webhook-catcher" ]]; then
  install_example "webhook-catcher" "Webhook Catcher" \
    "Catch and inspect incoming webhooks with a live dashboard" \
    "express" "true" "192"
fi

# 5. gpio-toolkit — Pi only
if $IS_PI && [[ -d "$EXAMPLES_DIR/gpio-toolkit" ]]; then
  install_example "gpio-toolkit" "GPIO Toolkit" \
    "REST API for Raspberry Pi GPIO, I2C, SPI, and PWM control" \
    "express" "false" "192"
fi

# Reload nginx
nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || true

# Save PM2 state
sudo -u "$SPAWN_USER" pm2 save 2>/dev/null || true

echo "[seed] Done — $installed installed, $skipped skipped"
