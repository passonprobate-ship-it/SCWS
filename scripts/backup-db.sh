#!/bin/bash
# SPAWN backup script
# Runs nightly via cron, retains 7 days of backups
# Covers: all PostgreSQL databases + project source code + nginx configs + daemon config

export PATH="/usr/bin:/usr/local/bin:$PATH"
export HOME="/home/codeman"

BACKUP_DIR="/var/www/scws/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

mkdir -p "${BACKUP_DIR}"

# --- PostgreSQL Databases ---

# Dump the main daemon database
pg_dump -U scws -h localhost scws_daemon | gzip > "${BACKUP_DIR}/scws_daemon_${TIMESTAMP}.sql.gz"

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: scws_daemon_${TIMESTAMP}.sql.gz"
else
    echo "[$(date)] ERROR: Backup failed for scws_daemon" >&2
fi

# Dump any project databases (anything owned by scws that isn't the main DB or template)
for db in $(psql -U scws -h localhost -d postgres -t -A -c "SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = 'scws') AND datname NOT IN ('scws_daemon', 'postgres', 'template0', 'template1');"); do
    pg_dump -U scws -h localhost "$db" | gzip > "${BACKUP_DIR}/${db}_${TIMESTAMP}.sql.gz"
    if [ $? -eq 0 ]; then
        echo "[$(date)] Backup successful: ${db}_${TIMESTAMP}.sql.gz"
    else
        echo "[$(date)] WARNING: Backup failed for ${db}" >&2
    fi
done

# --- Project Source Code ---
# Tar up all project source (excluding node_modules, dist, .git to save space)
tar czf "${BACKUP_DIR}/projects_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.git' \
    --exclude='*.log' \
    -C /var/www/scws projects/ 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: projects_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: Project files backup failed" >&2
fi

# --- Nginx Configs ---
tar czf "${BACKUP_DIR}/nginx_configs_${TIMESTAMP}.tar.gz" \
    -C /var/www/scws nginx/ 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: nginx_configs_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: Nginx config backup failed" >&2
fi

# --- Daemon Config ---
tar czf "${BACKUP_DIR}/daemon_config_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='dist' \
    -C /var/www/scws daemon/.env daemon/ecosystem.config.cjs 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: daemon_config_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: Daemon config backup failed" >&2
fi

# --- Daemon (SPAWN control plane — the web interface + API) ---
# Excludes node_modules (reinstallable) and .cjs.bak files
# dist/ IS included — contains the built dashboard.html + index.cjs needed to run
tar czf "${BACKUP_DIR}/daemon_full_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='*.bak' \
    -C /var/www/scws daemon/ 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: daemon_full_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: Daemon full backup failed" >&2
fi

# --- CLAUDE.md + scripts (SPAWN identity + automation) ---
tar czf "${BACKUP_DIR}/spawn_core_${TIMESTAMP}.tar.gz" \
    -C /var/www/scws CLAUDE.md scripts/ 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: spawn_core_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: SPAWN core files backup failed" >&2
fi

# --- System nginx config (main site, not just project blocks) ---
sudo tar czf "${BACKUP_DIR}/nginx_system_${TIMESTAMP}.tar.gz" \
    -C /etc nginx/sites-enabled/ nginx/nginx.conf 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: nginx_system_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: System nginx backup failed" >&2
fi

# --- Claude memory (accumulated knowledge) ---
tar czf "${BACKUP_DIR}/claude_memory_${TIMESTAMP}.tar.gz" \
    -C /home/codeman .claude/projects/-var-www-scws/memory/ 2>/dev/null

if [ $? -eq 0 ]; then
    echo "[$(date)] Backup successful: claude_memory_${TIMESTAMP}.tar.gz"
else
    echo "[$(date)] WARNING: Claude memory backup failed" >&2
fi

# --- Crontab ---
crontab -l > "${BACKUP_DIR}/crontab_${TIMESTAMP}.txt" 2>/dev/null
echo "[$(date)] Backup successful: crontab_${TIMESTAMP}.txt"

# --- PM2 process list ---
pm2 jlist > "${BACKUP_DIR}/pm2_processes_${TIMESTAMP}.json" 2>/dev/null
echo "[$(date)] Backup successful: pm2_processes_${TIMESTAMP}.json"

# --- Prune old backups ---
find "${BACKUP_DIR}" \( -name "*.sql.gz" -o -name "*.tar.gz" -o -name "*.json" -o -name "*.txt" \) -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Pruned backups older than ${RETENTION_DAYS} days"
