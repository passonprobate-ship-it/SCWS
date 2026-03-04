#!/usr/bin/env bash
# =============================================================================
# SPAWN Memory Seed — Populate spawn_memories with universal knowledge
# =============================================================================
# Seeds 9 curated knowledge entries into the spawn_memories table so new
# SPAWN nodes start with architecture docs, workflow policies, and lessons
# learned from previous deployments.
#
# Idempotent: uses INSERT ON CONFLICT DO NOTHING — never overwrites
# user-customized entries. Safe to run multiple times.
#
# Usage (runs on VPS, typically called by deploy.sh):
#   bash seed-memory.sh                  # Uses default DB
#   SPAWN_DB=mydb bash seed-memory.sh    # Custom database name
#
# =============================================================================
set -euo pipefail

SPAWN_DB="${SPAWN_DB:-scws_daemon}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[SEED]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# ── Verify database access ──────────────────────────────────────────────────
if ! sudo -u postgres psql "$SPAWN_DB" -c "SELECT 1;" &>/dev/null; then
  warn "Cannot access database '$SPAWN_DB' — skipping memory seed."
  exit 0
fi

# ── Verify spawn_memories table exists ──────────────────────────────────────
TABLE_EXISTS=$(sudo -u postgres psql "$SPAWN_DB" -t -A -c "
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'spawn_memories'
  );" 2>/dev/null || echo "f")

if [[ "$TABLE_EXISTS" != "t" ]]; then
  warn "spawn_memories table not found — skipping memory seed."
  exit 0
fi

log "Seeding universal knowledge into spawn_memories..."

# ── Helper: insert one memory (idempotent) ──────────────────────────────────
# Usage: seed_memory "key" "value" "tags_json"
seed_memory() {
  local key="$1"
  local value="$2"
  local tags="$3"

  sudo -u postgres psql "$SPAWN_DB" -q -c "
    INSERT INTO spawn_memories (key, value, tags, updated_at)
    VALUES (\$\$${key}\$\$, \$\$${value}\$\$, '${tags}', NOW())
    ON CONFLICT (key) DO NOTHING;
  " 2>/dev/null

  if [[ $? -eq 0 ]]; then
    log "  Seeded: $key"
  fi
}

# =============================================================================
# 1. scws-architecture — Daemon source structure and API patterns
# =============================================================================
seed_memory "scws-architecture" \
"## SCWS Daemon — Architecture

Source structure:
  shared/schema.ts — Drizzle ORM tables (projects, claude_runs, activity_log, daemon_config, spawn_memories)
  daemon/index.ts — Express app, REST routes, auth, middleware
  daemon/storage.ts — IStorage interface + DatabaseStorage (all DB queries)
  daemon/projects.ts — Project lifecycle (create, scaffold, start, stop, build, delete)
  daemon/claude.ts — Claude CLI runner (headless, SSE streaming, sessions)
  daemon/channels.ts — Notification channels (Telegram, Email, rules, dispatcher)
  daemon/terminal.ts — Web terminal (xterm.js + node-pty + WebSocket, max 3 sessions)
  daemon/mcp.ts — MCP server config management (settings.json I/O, sanitization)
  daemon/github.ts — GitHub CLI wrapper (init, clone, push, pull)
  daemon/deploy.ts — Build + SCP deployment to remote servers
  daemon/nginx.ts — nginx config generation + reload
  daemon/pm2.ts — PM2 process management wrapper
  daemon/dashboard.html — Single-file SPA (vanilla JS, no framework)
  script/build.ts — esbuild bundler -> dist/index.cjs + dist/dashboard.html

Build: npx tsx script/build.ts -> dist/index.cjs + dist/dashboard.html

API sections: Health, Projects, Claude CLI, GitHub, Deploy, Import, Log streaming, MCP, Channels, System
Auth: Bearer token (DASHBOARD_TOKEN), timing-safe compare, query param fallback for SSE
Patterns: asyncHandler wrapper, storage.* for all DB, sanitize configs before dashboard" \
'["architecture","daemon","reference"]'

# =============================================================================
# 2. workflow-save-plan-before-work — Mandatory workflow policy
# =============================================================================
seed_memory "workflow-save-plan-before-work" \
"## MANDATORY WORKFLOW: Save Plan Before Starting Work

Whenever Claude makes a plan for a task and is about to begin implementation:

### Before Starting Work
1. Save the plan to spawn-mcp memory using spawn_remember
   - Key format: \"active-task-{project-name}\"
   - Include: what the task is, the full plan/steps, current status (\"starting\")
   - Tags: [\"active-task\", \"{project-name}\", \"in-progress\"]
2. THEN start the actual work

### During Work
- After completing significant milestones or steps, update the same memory key with:
  - Which steps are done
  - What step you are currently on
  - Any decisions made or problems encountered

### On Completion
- Update the memory to status \"complete\" with a summary of what was done
- Or if the task is ongoing/paused, mark it as such with clear next steps

### Why
If the session disconnects or restarts, the next Claude instance can:
1. Read \"active-task-{project}\" from spawn-mcp
2. See exactly what was planned and how far along it got
3. Resume from the last saved checkpoint instead of starting over

This is a PERMANENT workflow rule. Always do this for non-trivial tasks." \
'["workflow","policy","mandatory"]'

# =============================================================================
# 3. spawn-mcp-default-policy — spawn-mcp is the default memory system
# =============================================================================
seed_memory "spawn-mcp-default-policy" \
"## spawn-mcp Default Memory Policy

spawn-mcp (port 5020, localhost) is the DEFAULT and PRIMARY MCP server for all SPAWN project data, memories, and saves. This is a permanent system-level default.

Rules:
1. ALL project memories, notes, architecture docs, bootstrap fixes, deployment info, and general SPAWN knowledge go to spawn-mcp FIRST
2. Do NOT default to external MCP servers for SPAWN project data
3. Other MCP servers the user has connected are fine for their own purposes
4. When saving new information learned during a session, use spawn_remember
5. When looking up project knowledge, use spawn_recall / spawn_list_memories
6. This policy applies to all Claude Code sessions on this machine

spawn-mcp lives in the scws_daemon PostgreSQL database (spawn_memories table). It is local, fast, and under SPAWN's full control." \
'["policy","mcp","memory"]'

# =============================================================================
# 4. bootstrap-fix-projects-db — Always register projects in DB
# =============================================================================
seed_memory "bootstrap-fix-projects-db" \
"## Bootstrap Fix: Projects Not in Dashboard DB

Problem: Projects running in PM2 + nginx but not appearing in SPAWN dashboard (/api/projects returns []).
Root cause: projects table in scws_daemon was empty — projects were manually created without DB registration.

Fix: Always INSERT into projects table after creating any project:
INSERT INTO projects (name, display_name, description, port, status, framework, entry_file, start_command)
VALUES ('name', 'Display Name', 'Description', 5001, 'running', 'express', 'dist/index.js', 'node dist/index.js');

Or use the daemon REST API: POST http://localhost:4000/api/projects with Bearer token.

Bootstrap lesson: Never assume a running PM2 process = a registered project. The dashboard source of truth is the projects table." \
'["lesson","bootstrap","projects"]'

# =============================================================================
# 5. web-terminal-notes — Web terminal implementation
# =============================================================================
seed_memory "web-terminal-notes" \
"## Web Terminal Implementation Notes

SPAWN daemon has a real PTY-based web terminal: xterm.js frontend + node-pty backend over WebSocket.
Max 3 concurrent sessions, 30-min idle timeout.
Located in daemon/terminal.ts, accessible via Dashboard Terminal page (Ctrl+J).

Alternative standalone options:
- ttyd (single binary, simplest): ttyd bash -> port 7681
- wetty (Node.js, over SSH)
- GoTTY (Go)

Security: Always behind auth. SPAWN uses Bearer token auth on all dashboard endpoints." \
'["terminal","reference","daemon"]'

# =============================================================================
# 6. context-aware-multi-claude-interface — Claude session feature docs
# =============================================================================
seed_memory "context-aware-multi-claude-interface" \
"## Context-Aware Multi-Claude Interface

### What It Is
Project-specific Claude CLI sessions launched from project cards on the dashboard. Each session gets full project context auto-injected (metadata, activity, MCP memories). Up to 4 concurrent sessions with tab switching.

### How To Use
- Go to Projects page -> click the cyan \"Claude\" button on any project card
- Navigates to Sessions page with a live interactive Claude CLI terminal
- Claude CWD is set to /var/www/scws/projects/{name}
- Context injected via --append-system-prompt

### Key Code
- Frontend: dashboard.html — openClaudeSession(), createClaudeTerminal(), switchClaudeSession()
- Backend: index.cjs — buildClaudeContext(), createClaudeSession(), attachClaudeSession(), detachClaudeSession()
- Sessions page in sidebar nav, session tab bar, scrollback replay on reattach

### API Routes
- WS /api/claude-terminal?project=<name> — new session
- WS /api/claude-terminal?session=<id> — reattach
- GET /api/claude-terminal/sessions — list sessions
- POST /api/claude-terminal/sessions/{id}/kill — terminate
- GET /api/claude-terminal/context/{projectName} — preview context

### NOT the same as
The \"Run Claude\" button inside project detail view (Claude tab) — that is the older headless batch runner. Different feature." \
'["claude","sessions","dashboard","reference"]'

# =============================================================================
# 7. vps-deployment-lessons — Deployment lessons learned (generalized)
# =============================================================================
seed_memory "vps-deployment-lessons" \
"## VPS Deployment Lessons Learned

Bash/curl: Bearer token in double-quoted headers gets silently stripped. Use single quotes. printf works; echo -n does not reliably in all shells.

PostgreSQL on Ubuntu 24.04: Default pg_hba.conf uses peer auth. Must change to md5 for app users, then reload postgresql.

PM2: Use --node-args=\"--env-file=.env\" for apps without dotenv. pm2 save + pm2 startup for reboot persistence.

DuckDNS: Domain names are case-sensitive and exact. Verify DNS resolution before certbot.

SSH provisioning: SSH may take 15-30s after instance reports active. Always poll before running commands.

npm install on VPS: Must rebuild native modules (like node-pty) for target arch. Use --omit=dev to keep lean." \
'["deployment","lessons","vps"]'

# =============================================================================
# 8. ssl-setup-pattern — DuckDNS + certbot pattern (generalized)
# =============================================================================
seed_memory "ssl-setup-pattern" \
"## SSL Setup Pattern: DuckDNS + Let's Encrypt

Pattern for adding SSL to any SPAWN VPS deployment:

1. Set up nginx with HTTP first (deploy.sh handles this)
2. Point a DuckDNS domain to the VPS IP (done manually at duckdns.org)
3. Verify HTTP works: curl http://<domain>/health
4. Install certbot: sudo apt install certbot python3-certbot-nginx
5. Run certbot: certbot --nginx -d <domain> --non-interactive --agree-tos --email <email> --redirect
6. Update app .env BASE_URL to https://<domain>
7. Restart PM2 process

Notes:
- DuckDNS domain names are case-sensitive and exact
- certbot --nginx auto-modifies the nginx config for SSL
- Certs auto-renew via systemd timer (certbot.timer)
- Always verify DNS resolution before running certbot" \
'["ssl","deployment","pattern"]'

# =============================================================================
# 9. mcp-session-resilience — MCP session TTL/grace/reaper notes
# =============================================================================
seed_memory "mcp-session-resilience" \
"## MCP Session Resilience Notes

MCP session handling: TTL 2 hours (default was 30min), 30-min grace period before hard expiry, two-phase reaper (soft then hard), spec-compliant 404/-32001 error for expired sessions.

Env vars: SESSION_TTL_MS, SESSION_GRACE_MS, MAX_MCP_SESSIONS. Sessions are in-memory only.

These settings apply to any MCP server running with the SPAWN daemon's MCP module. Adjust TTL based on expected session duration." \
'["mcp","sessions","resilience"]'

# ── Summary ──────────────────────────────────────────────────────────────────
SEEDED=$(sudo -u postgres psql "$SPAWN_DB" -t -A -c "SELECT COUNT(*) FROM spawn_memories;" 2>/dev/null || echo "?")
log "Memory seed complete. Total entries in spawn_memories: ${SEEDED}"
