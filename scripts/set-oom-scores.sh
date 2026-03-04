#!/bin/bash
# =============================================================================
# SPAWN OOM Score Assignment
# =============================================================================
# Sets OOM killer priorities so the kernel kills expendable projects before
# critical infrastructure. Lower oom_score_adj = more protected.
#
# Run after PM2 startup and after each project start/stop.
# =============================================================================

set -euo pipefail

log() { echo "[OOM] $*"; }

set_oom() {
  local name="$1" score="$2"
  local pid
  pid=$(pm2 pid "$name" 2>/dev/null || true)
  if [[ -n "$pid" && "$pid" != "0" && -d "/proc/$pid" ]]; then
    printf '%d' "$score" | sudo tee "/proc/$pid/oom_score_adj" > /dev/null 2>&1 && \
      log "$name (pid $pid) → oom_score_adj=$score" || \
      log "$name (pid $pid) → failed to set (may need root)"
  fi
}

# Critical infrastructure — heavily protected
set_oom "scws-daemon" -500

# Important services — protected
set_oom "spawn-mcp" -300

# Projects — expendable (auto-restart via PM2)
for proj in $(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name != "scws-daemon" and .name != "spawn-mcp" and .name != "pm2-logrotate" and .pm2_env.status == "online") | .name' 2>/dev/null || true); do
  set_oom "$proj" 300
done

log "OOM scores applied."
