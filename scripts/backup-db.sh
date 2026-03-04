#!/bin/bash
# SPAWN backup script
# Runs nightly via cron, retains 7 days of backups
# Covers: all PostgreSQL databases + project source code + nginx configs + daemon config

set -eo pipefail

export PATH="/usr/bin:/usr/local/bin:$PATH"
export HOME="/home/codeman"

BACKUP_DIR="/var/www/scws/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7
ERRORS=0

mkdir -p "${BACKUP_DIR}"

# Helper: verify backup file exists and is non-empty
verify_backup() {
    local file="$1" label="$2"
    if [ -s "$file" ]; then
        echo "[$(date)] Backup successful: $(basename "$file") ($(stat -c%s "$file") bytes)"
    else
        echo "[$(date)] ERROR: Backup empty or missing: $label" >&2
        rm -f "$file"
        ERRORS=$((ERRORS + 1))
    fi
}

# --- PostgreSQL Databases ---

# Dump the main daemon database (use PIPESTATUS to catch pg_dump failures through gzip)
pg_dump -U scws -h localhost scws_daemon | gzip > "${BACKUP_DIR}/scws_daemon_${TIMESTAMP}.sql.gz"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
    verify_backup "${BACKUP_DIR}/scws_daemon_${TIMESTAMP}.sql.gz" "scws_daemon"
else
    echo "[$(date)] ERROR: pg_dump failed for scws_daemon" >&2
    rm -f "${BACKUP_DIR}/scws_daemon_${TIMESTAMP}.sql.gz"
    ERRORS=$((ERRORS + 1))
fi

# Dump any project databases (anything owned by scws that isn't the main DB or template)
for db in $(psql -U scws -h localhost -d postgres -t -A -c "SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = 'scws') AND datname NOT IN ('scws_daemon', 'postgres', 'template0', 'template1');" 2>/dev/null); do
    pg_dump -U scws -h localhost "$db" | gzip > "${BACKUP_DIR}/${db}_${TIMESTAMP}.sql.gz"
    if [ "${PIPESTATUS[0]}" -eq 0 ]; then
        verify_backup "${BACKUP_DIR}/${db}_${TIMESTAMP}.sql.gz" "$db"
    else
        echo "[$(date)] WARNING: pg_dump failed for ${db}" >&2
        rm -f "${BACKUP_DIR}/${db}_${TIMESTAMP}.sql.gz"
        ERRORS=$((ERRORS + 1))
    fi
done

# --- Project Source Code ---
tar czf "${BACKUP_DIR}/projects_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='*.log' \
    -C /var/www/scws projects/ 2>/dev/null
verify_backup "${BACKUP_DIR}/projects_${TIMESTAMP}.tar.gz" "projects"

# --- Nginx Configs ---
tar czf "${BACKUP_DIR}/nginx_configs_${TIMESTAMP}.tar.gz" \
    -C /var/www/scws nginx/ 2>/dev/null
verify_backup "${BACKUP_DIR}/nginx_configs_${TIMESTAMP}.tar.gz" "nginx_configs"

# --- Daemon Config ---
tar czf "${BACKUP_DIR}/daemon_config_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='dist' \
    -C /var/www/scws daemon/.env daemon/ecosystem.config.cjs 2>/dev/null
verify_backup "${BACKUP_DIR}/daemon_config_${TIMESTAMP}.tar.gz" "daemon_config"

# --- Daemon (SPAWN control plane — the web interface + API) ---
tar czf "${BACKUP_DIR}/daemon_full_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='*.bak' \
    -C /var/www/scws daemon/ 2>/dev/null
verify_backup "${BACKUP_DIR}/daemon_full_${TIMESTAMP}.tar.gz" "daemon_full"

# --- CLAUDE.md + scripts (SPAWN identity + automation) ---
tar czf "${BACKUP_DIR}/spawn_core_${TIMESTAMP}.tar.gz" \
    -C /var/www/scws CLAUDE.md scripts/ 2>/dev/null
verify_backup "${BACKUP_DIR}/spawn_core_${TIMESTAMP}.tar.gz" "spawn_core"

# --- System nginx config (main site, not just project blocks) ---
sudo tar czf "${BACKUP_DIR}/nginx_system_${TIMESTAMP}.tar.gz" \
    -C /etc nginx/sites-enabled/ nginx/nginx.conf 2>/dev/null
verify_backup "${BACKUP_DIR}/nginx_system_${TIMESTAMP}.tar.gz" "nginx_system"

# --- Claude memory (accumulated knowledge) ---
tar czf "${BACKUP_DIR}/claude_memory_${TIMESTAMP}.tar.gz" \
    -C /home/codeman .claude/projects/-var-www-scws/memory/ 2>/dev/null
verify_backup "${BACKUP_DIR}/claude_memory_${TIMESTAMP}.tar.gz" "claude_memory"

# --- Crontab ---
crontab -l > "${BACKUP_DIR}/crontab_${TIMESTAMP}.txt" 2>/dev/null
echo "[$(date)] Backup successful: crontab_${TIMESTAMP}.txt"

# --- PM2 process list ---
pm2 jlist > "${BACKUP_DIR}/pm2_processes_${TIMESTAMP}.json" 2>/dev/null
echo "[$(date)] Backup successful: pm2_processes_${TIMESTAMP}.json"

# --- Prune old backups ---
find "${BACKUP_DIR}" \( -name "*.sql.gz" -o -name "*.tar.gz" -o -name "*.json" -o -name "*.txt" \) -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Pruned backups older than ${RETENTION_DAYS} days"

if [ "$ERRORS" -gt 0 ]; then
    echo "[$(date)] WARNING: ${ERRORS} backup(s) had errors" >&2
fi
