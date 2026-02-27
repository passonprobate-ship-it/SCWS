#!/bin/bash
# SCWS Health Check — runs every 5 minutes via cron

STATE_FILE="/var/www/scws/logs/health-state.json"
LOG_FILE="/var/www/scws/logs/health.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

check_service() {
  systemctl is-active --quiet "$1" && echo "ok" || echo "down"
}

# Check services
NGINX=$(check_service nginx)
POSTGRES=$(check_service postgresql)
DAEMON=$(curl -sf http://127.0.0.1:4000/health >/dev/null 2>&1 && echo "ok" || echo "down")
FAIL2BAN=$(check_service fail2ban)

# Disk usage
DISK_PCT=$(df / --output=pcent | tail -1 | tr -d ' %')
DISK_STATUS="ok"
[ "$DISK_PCT" -gt 90 ] && DISK_STATUS="critical"
[ "$DISK_PCT" -gt 80 ] && [ "$DISK_PCT" -le 90 ] && DISK_STATUS="warning"

# Memory
MEM_AVAIL=$(free -m | awk '/Mem:/ {print $7}')
MEM_STATUS="ok"
[ "$MEM_AVAIL" -lt 100 ] && MEM_STATUS="critical"
[ "$MEM_AVAIL" -lt 256 ] && [ "$MEM_AVAIL" -ge 100 ] && MEM_STATUS="warning"

# Write state
cat > "$STATE_FILE" << EOF
{
  "timestamp": "$(date -Iseconds)",
  "services": {
    "nginx": "$NGINX",
    "postgresql": "$POSTGRES",
    "daemon": "$DAEMON",
    "fail2ban": "$FAIL2BAN"
  },
  "disk": {
    "percent": $DISK_PCT,
    "status": "$DISK_STATUS"
  },
  "memory": {
    "available_mb": $MEM_AVAIL,
    "status": "$MEM_STATUS"
  }
}
EOF

# Log issues
[ "$NGINX" = "down" ] && log "ALERT: nginx is down"
[ "$POSTGRES" = "down" ] && log "ALERT: postgresql is down"
[ "$DAEMON" = "down" ] && log "ALERT: SCWS daemon is down"
[ "$DISK_STATUS" = "critical" ] && log "ALERT: Disk usage at ${DISK_PCT}%"
[ "$MEM_STATUS" = "critical" ] && log "ALERT: Memory available ${MEM_AVAIL}MB"

# Try to restart daemon if down
if [ "$DAEMON" = "down" ]; then
  log "Attempting to restart scws-daemon..."
  pm2 restart scws-daemon 2>/dev/null || true
fi
