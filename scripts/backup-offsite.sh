#!/bin/bash
# SPAWN off-site backup — pushes local backups to MCP server
# Runs after backup-db.sh via cron
# Retention: 7 per name (auto-pruned server-side on upload)

set -euo pipefail

export PATH="/usr/bin:/usr/local/bin:$PATH"
export HOME="/home/codeman"

# Source token from daemon env instead of hardcoding
OFFSITE_TOKEN_FILE="/var/www/scws/scripts/.backup-token"
if [ -f "$OFFSITE_TOKEN_FILE" ]; then
    MCP_BACKUP_TOKEN=$(cat "$OFFSITE_TOKEN_FILE")
else
    echo "[$(date)] ERROR: Missing backup token file at $OFFSITE_TOKEN_FILE" >&2
    exit 1
fi

MCP_BACKUP_URL="https://passoncloud.duckdns.org/api/backups"
BACKUP_DIR="/var/www/scws/backups"

# Cleanup temp files on any exit
cleanup() { rm -f /tmp/spawn-backup-*.json /tmp/spawn-b64-*.txt; }
trap cleanup EXIT

upload_backup() {
    local name="$1" file="$2" retention="${3:-7}"
    local orig
    orig=$(basename "$file")
    local size
    size=$(stat -c%s "$file")

    # Skip files > 10MB
    if [ "$size" -gt 10485760 ]; then
        echo "[$(date)] SKIP: $orig is $(( size / 1048576 ))MB (>10MB limit)" >&2
        return 1
    fi

    # Build JSON payload via temp file to avoid argument-list-too-long for large files
    local tmpfile b64file
    tmpfile=$(mktemp /tmp/spawn-backup-XXXXXX.json)
    b64file=$(mktemp /tmp/spawn-b64-XXXXXX.txt)

    base64 -w0 "$file" > "$b64file"

    jq -cn \
        --arg name "$name" \
        --rawfile data "$b64file" \
        --arg src "spawn-pi5" \
        --arg orig "$orig" \
        --argjson ret "$retention" \
        '{name:$name, data:($data | rtrimstr("\n")), source:$src, originalName:$orig, retention:$ret}' \
        > "$tmpfile"
    rm -f "$b64file"

    local response
    if response=$(curl -sf --max-time 120 -X POST "$MCP_BACKUP_URL" \
        -H "Authorization: Bearer $MCP_BACKUP_TOKEN" \
        -H "Content-Type: application/json" \
        -d @"$tmpfile"); then
        rm -f "$tmpfile"
        if echo "$response" | jq -e '.id' > /dev/null 2>&1; then
            local remote_size
            remote_size=$(echo "$response" | jq -r '.sizeBytes')
            echo "[$(date)] Uploaded: $orig ($remote_size bytes) → $name"
            return 0
        fi
    fi

    rm -f "$tmpfile"
    echo "[$(date)] FAILED: $orig → $name" >&2
    return 1
}

# Find the most recent backup of each type by modification time
find_latest() {
    local pattern="$1"
    find "$BACKUP_DIR" -maxdepth 1 -name "$pattern" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-
}

echo "=== Off-site backup started at $(date) ==="

TOTAL=0
SUCCESS=0

# Database dumps
for db_prefix in scws_daemon spawn_cortex solbot_db; do
    latest=$(find_latest "${db_prefix}_*.sql.gz")
    if [ -n "$latest" ]; then
        # Map local file prefix to remote backup name
        case "$db_prefix" in
            scws_daemon)   remote_name="spawn-daemon-db" ;;
            spawn_cortex)  remote_name="spawn-cortex-db" ;;
            solbot_db)     remote_name="spawn-solbot-db" ;;
            *)             remote_name="spawn-${db_prefix}" ;;
        esac
        TOTAL=$((TOTAL + 1))
        if upload_backup "$remote_name" "$latest" 7; then
            SUCCESS=$((SUCCESS + 1))
        fi
    else
        echo "[$(date)] WARN: No backup found for ${db_prefix}_*.sql.gz"
    fi
done

# Project source tarball
latest=$(find_latest "projects_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-projects" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# Nginx configs
latest=$(find_latest "nginx_configs_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-nginx" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# Daemon config
latest=$(find_latest "daemon_config_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-daemon-config" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# PM2 process state
latest=$(find_latest "pm2_processes_*.json")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-pm2" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# Daemon full (SPAWN web interface + API — the control plane)
latest=$(find_latest "daemon_full_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-daemon-full" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# SPAWN core (CLAUDE.md + scripts)
latest=$(find_latest "spawn_core_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-core" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# System nginx (main site config)
latest=$(find_latest "nginx_system_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-nginx-system" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# Claude memory (accumulated knowledge across sessions)
latest=$(find_latest "claude_memory_*.tar.gz")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-claude-memory" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

# Crontab
latest=$(find_latest "crontab_*.txt")
if [ -n "$latest" ]; then
    TOTAL=$((TOTAL + 1))
    if upload_backup "spawn-crontab" "$latest" 7; then
        SUCCESS=$((SUCCESS + 1))
    fi
fi

echo "=== Off-site backup finished: ${SUCCESS}/${TOTAL} uploaded ==="

if [ "$SUCCESS" -lt "$TOTAL" ]; then
    exit 1
fi
