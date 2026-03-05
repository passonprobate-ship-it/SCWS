#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# SPAWN Onboarding Script
# Post-deploy setup: Claude Code CLI, auth, GitHub CLI, MCP settings
# Usage: bash onboard.sh [--status] [--step N] [--reset]
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="/var/www/scws/daemon"
DAEMON_URL="http://localhost:4000"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Source detection library
source "$SCRIPT_DIR/lib/onboard-detect.sh"

# Load dashboard token for API calls
DASHBOARD_TOKEN=""
if [[ -f "$DAEMON_DIR/.env" ]]; then
  DASHBOARD_TOKEN=$(grep '^DASHBOARD_TOKEN=' "$DAEMON_DIR/.env" 2>/dev/null | cut -d= -f2-)
fi

# ============================================================================
# Helpers
# ============================================================================

print_header() {
  printf '\n'
  printf "${CYAN}${BOLD}"
  printf '  ____  ____   ___  _      __ _   _\n'
  printf ' / ___||  _ \\ / _ \\| |    / /| \\ | |\n'
  printf ' \\___ \\| |_) / /_\\ | | /\\/ / |  \\| |\n'
  printf '  ___) |  __/ ___ | |/ __/  | |\\  |\n'
  printf ' |____/|_| /_/   \\_|__/\\_\\  |_| \\_|\n'
  printf "${RESET}\n"
  printf "  ${DIM}Post-Deploy Onboarding${RESET}\n\n"
}

print_step() {
  local num="$1" label="$2" status="$3" required="${4:-yes}"
  local icon color tag=""

  case "$status" in
    complete)  icon="[x]"; color="$GREEN" ;;
    skipped)   icon="[-]"; color="$DIM" ;;
    current)   icon="[>]"; color="$YELLOW" ;;
    *)         icon="[ ]"; color="$DIM" ;;
  esac

  if [[ "$required" == "yes" ]]; then
    tag=" \033[0;31mREQUIRED\033[0m"
  else
    tag=" \033[2moptional\033[0m"
  fi

  printf "  ${color}${icon}${RESET} ${BOLD}Step %d${RESET}: %s${tag}\n" "$num" "$label"
}

update_state() {
  local key="$1" value="$2"
  if [[ -n "$DASHBOARD_TOKEN" ]]; then
    curl -sf -X POST "$DAEMON_URL/api/onboard/update" \
      -H "Authorization: Bearer $DASHBOARD_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"key\":\"$key\",\"value\":\"$value\"}" >/dev/null 2>&1 || true
  fi
}

prompt_choice() {
  local prompt="$1"
  shift
  local options=("$@")
  local i=1

  printf "\n  ${BOLD}%s${RESET}\n" "$prompt"
  for opt in "${options[@]}"; do
    printf "    ${CYAN}%d${RESET}) %s\n" "$i" "$opt"
    ((i++))
  done
  printf "\n  Enter choice [1-%d]: " "${#options[@]}"
  read -r choice
  printf '%s' "$choice"
}

prompt_yn() {
  local prompt="$1" default="${2:-y}"
  local yn_hint="[Y/n]"
  [[ "$default" == "n" ]] && yn_hint="[y/N]"

  printf "  %s %s " "$prompt" "$yn_hint"
  read -r answer
  answer="${answer:-$default}"
  [[ "${answer,,}" == "y" ]]
}

wait_enter() {
  printf "\n  ${DIM}Press Enter to continue...${RESET}"
  read -r
}

success_msg() {
  printf "  ${GREEN}OK${RESET} %s\n" "$1"
}

error_msg() {
  printf "  ${RED}ERROR${RESET} %s\n" "$1"
}

info_msg() {
  printf "  ${CYAN}INFO${RESET} %s\n" "$1"
}

warn_msg() {
  printf "  ${YELLOW}WARN${RESET} %s\n" "$1"
}

# ============================================================================
# Step 1: Daemon Health Check
# ============================================================================

step_1_health() {
  printf "\n${BOLD}  Step 1: Daemon Health Check${RESET}\n"
  printf "  ${DIM}Verifying SPAWN daemon is running on port 4000...${RESET}\n\n"

  local health
  health=$(curl -sf "$DAEMON_URL/health" 2>/dev/null) || true

  if [[ -n "$health" ]]; then
    success_msg "Daemon is responding on $DAEMON_URL"
    update_state "onboard-status" "in-progress"
    update_state "onboard-started-at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
  else
    error_msg "Daemon is not responding on $DAEMON_URL"
    printf "\n  Try:\n"
    printf "    ${CYAN}pm2 start /var/www/scws/daemon/ecosystem.config.cjs${RESET}\n"
    printf "    ${CYAN}pm2 logs scws-daemon --lines 20${RESET}\n"
    return 1
  fi
}

# ============================================================================
# Step 2: Claude Code CLI
# ============================================================================

step_2_claude_cli() {
  printf "\n${BOLD}  Step 2: Install Claude Code CLI${RESET}\n"
  printf "  ${DIM}Claude Code is the AI engine that powers SPAWN sessions.${RESET}\n"

  local claude_path
  claude_path=$(detect_claude_cli) && {
    local version
    version=$("$claude_path" --version 2>/dev/null || echo "unknown")
    success_msg "Claude Code CLI found at $claude_path (v$version)"
    update_state "onboard-claude-cli" "installed"
    return 0
  }

  printf "\n  Claude Code CLI is not installed.\n"

  local choice
  choice=$(prompt_choice "Choose install method:" \
    "Claude Code — official installer (recommended)" \
    "Claude Code — npm global install" \
    "OpenCode — open-source alternative (opencode.ai)" \
    "Skip for now")

  case "$choice" in
    1)
      printf "\n  ${CYAN}Running official installer...${RESET}\n\n"
      if curl -fsSL https://claude.ai/install.sh | sh; then
        # Re-source PATH
        export PATH="$HOME/.local/bin:$PATH"
        if detect_claude_cli >/dev/null 2>&1; then
          success_msg "Claude Code CLI installed successfully"
          update_state "onboard-claude-cli" "installed"
          return 0
        fi
      fi
      error_msg "Installation failed. Try method 2 (npm) or install manually."
      return 1
      ;;
    2)
      printf "\n  ${CYAN}Installing via npm...${RESET}\n\n"
      if npm install -g @anthropic-ai/claude-code 2>&1; then
        if detect_claude_cli >/dev/null 2>&1; then
          success_msg "Claude Code CLI installed via npm"
          update_state "onboard-claude-cli" "installed"
          return 0
        fi
      fi
      error_msg "npm install failed. Check Node.js/npm are available."
      return 1
      ;;
    3)
      printf "\n  ${BOLD}About OpenCode vs Claude Code:${RESET}\n"
      printf "  ${DIM}OpenCode is open-source and supports 75+ LLM providers including Claude.${RESET}\n"
      printf "  ${DIM}However, Claude Code with a Max subscription (\$100/mo) is the best value${RESET}\n"
      printf "  ${DIM}for serious SPAWN use — heavy sessions can burn \$50+ in API credits per${RESET}\n"
      printf "  ${DIM}day, while Max gives unlimited use at a flat rate.${RESET}\n"
      printf "  ${DIM}OpenCode's free \"Big Pickle\" model is decent for lighter tasks if you${RESET}\n"
      printf "  ${DIM}want to try SPAWN without any cost.${RESET}\n\n"
      printf "  ${CYAN}Installing OpenCode...${RESET}\n\n"
      if curl -fsSL https://opencode.ai/install | bash; then
        export PATH="$HOME/.local/bin:$PATH"
        if command -v opencode &>/dev/null; then
          success_msg "OpenCode installed successfully"
          update_state "onboard-claude-cli" "installed"
          return 0
        fi
      fi
      error_msg "OpenCode installation failed. Try Claude Code (method 1 or 2) instead."
      return 1
      ;;
    4)
      warn_msg "Skipping CLI install. SPAWN won't be able to run AI sessions."
      return 1
      ;;
    *)
      error_msg "Invalid choice"
      return 1
      ;;
  esac
}

# ============================================================================
# Step 3: Claude Code Authentication
# ============================================================================

step_3_claude_auth() {
  printf "\n${BOLD}  Step 3: Authenticate Claude Code${RESET}\n"
  printf "  ${DIM}Claude needs valid credentials to run AI sessions.${RESET}\n"

  local auth_method
  auth_method=$(detect_claude_auth) && {
    success_msg "Claude Code is authenticated (method: $auth_method)"
    update_state "onboard-claude-auth" "authed"
    return 0
  }

  printf "\n  Claude Code is not authenticated.\n"

  local choice
  choice=$(prompt_choice "Choose authentication method:" \
    "OAuth login (claude.ai account — recommended)" \
    "API key (from console.anthropic.com)" \
    "Copy credentials from another machine" \
    "I don't have a Claude account yet")

  case "$choice" in
    1)
      printf "\n  ${BOLD}OAuth Login${RESET}\n"
      printf "  This will show a URL. Since this is a headless server:\n"
      printf "    1. Copy the URL that appears\n"
      printf "    2. Open it in a browser on your local machine\n"
      printf "    3. Log in and authorize\n"
      printf "    4. The CLI will detect the auth automatically\n"
      printf "\n  ${CYAN}Running: claude auth login${RESET}\n\n"

      local claude_bin
      claude_bin=$(detect_claude_cli) || claude_bin="claude"
      if "$claude_bin" auth login 2>&1; then
        if detect_claude_auth >/dev/null 2>&1; then
          success_msg "Claude Code authenticated via OAuth"
          update_state "onboard-claude-auth" "authed"
          return 0
        fi
      fi
      error_msg "OAuth login did not complete. Try another method."
      return 1
      ;;
    2)
      printf "\n  ${BOLD}API Key Authentication${RESET}\n"
      printf "  Get your API key from: ${CYAN}https://console.anthropic.com/settings/keys${RESET}\n"
      printf "\n  Paste your API key (starts with sk-ant-): "
      read -rs api_key
      printf "\n"

      if [[ -z "$api_key" ]]; then
        error_msg "No API key entered"
        return 1
      fi

      local claude_bin
      claude_bin=$(detect_claude_cli) || claude_bin="claude"

      # Write credentials directly
      mkdir -p "$HOME/.claude"
      printf '{"apiKey":"%s"}' "$api_key" > "$HOME/.claude/.credentials.json"
      chmod 600 "$HOME/.claude/.credentials.json"

      if detect_claude_auth >/dev/null 2>&1; then
        success_msg "Claude Code authenticated with API key"
        update_state "onboard-claude-auth" "authed"
        return 0
      fi
      error_msg "Failed to save API key"
      return 1
      ;;
    3)
      printf "\n  ${BOLD}Copy Credentials${RESET}\n"
      printf "  Copy the credentials file from another machine:\n\n"
      printf "    ${CYAN}scp user@other-machine:~/.claude/.credentials.json ~/.claude/.credentials.json${RESET}\n\n"
      printf "  Or paste the JSON content below (press Enter twice when done):\n  "

      local json_content=""
      local line
      while IFS= read -r line; do
        [[ -z "$line" ]] && break
        json_content+="$line"
      done

      if [[ -n "$json_content" ]]; then
        mkdir -p "$HOME/.claude"
        printf '%s' "$json_content" > "$HOME/.claude/.credentials.json"
        chmod 600 "$HOME/.claude/.credentials.json"

        if detect_claude_auth >/dev/null 2>&1; then
          success_msg "Credentials saved and verified"
          update_state "onboard-claude-auth" "authed"
          return 0
        fi
        error_msg "Credentials file doesn't contain valid auth data"
        return 1
      fi

      printf "\n  No content pasted. Run the scp command above, then re-run this step.\n"
      return 1
      ;;
    4)
      printf "\n  ${BOLD}Create a Claude Account${RESET}\n"
      printf "  You have two options:\n\n"
      printf "  ${CYAN}Claude Pro/Max (OAuth):${RESET}\n"
      printf "    1. Go to ${CYAN}https://claude.ai${RESET}\n"
      printf "    2. Sign up for an account\n"
      printf "    3. Subscribe to Pro or Max plan\n"
      printf "    4. Re-run this step and choose OAuth login\n\n"
      printf "  ${CYAN}API Access (pay-per-use):${RESET}\n"
      printf "    1. Go to ${CYAN}https://console.anthropic.com${RESET}\n"
      printf "    2. Create an account and add billing\n"
      printf "    3. Generate an API key\n"
      printf "    4. Re-run this step and choose API key\n"
      wait_enter
      return 1
      ;;
    *)
      error_msg "Invalid choice"
      return 1
      ;;
  esac

  # Note for OpenCode users
  local cli_bin
  cli_bin=$(detect_claude_cli 2>/dev/null) || true
  if [[ "$cli_bin" == *opencode* ]]; then
    printf "\n  ${DIM}Tip: OpenCode users can authenticate via the /connect command inside OpenCode.${RESET}\n"
  fi
}

# ============================================================================
# Step 4: GitHub CLI Auth (optional)
# ============================================================================

step_4_gh_auth() {
  printf "\n${BOLD}  Step 4: GitHub CLI Authentication${RESET} ${DIM}(optional)${RESET}\n"
  printf "  ${DIM}Enables git clone, push, and GitHub integration.${RESET}\n"

  local gh_user
  gh_user=$(detect_gh_auth) && {
    success_msg "GitHub CLI authenticated as $gh_user"
    update_state "onboard-gh-cli" "authed"
    return 0
  }

  if ! command -v gh &>/dev/null; then
    warn_msg "GitHub CLI (gh) is not installed. Skipping."
    update_state "onboard-gh-cli" "skipped"
    return 0
  fi

  if ! prompt_yn "Set up GitHub CLI authentication?" "y"; then
    info_msg "Skipped. You can set this up later with: gh auth login"
    update_state "onboard-gh-cli" "skipped"
    return 0
  fi

  local choice
  choice=$(prompt_choice "Choose auth method:" \
    "Personal Access Token (recommended for servers)" \
    "Browser OAuth (requires local browser)")

  case "$choice" in
    1)
      printf "\n  ${BOLD}Personal Access Token (PAT)${RESET}\n"
      printf "  1. Go to: ${CYAN}https://github.com/settings/tokens${RESET}\n"
      printf "  2. Generate a new token (classic) with 'repo' scope\n"
      printf "  3. Copy the token\n\n"
      printf "  Paste your GitHub token: "
      read -rs gh_token
      printf "\n"

      if [[ -z "$gh_token" ]]; then
        warn_msg "No token entered. Skipping."
        update_state "onboard-gh-cli" "skipped"
        return 0
      fi

      if printf '%s' "$gh_token" | gh auth login --with-token 2>&1; then
        if detect_gh_auth >/dev/null 2>&1; then
          success_msg "GitHub CLI authenticated"
          update_state "onboard-gh-cli" "authed"
          return 0
        fi
      fi
      error_msg "GitHub auth failed. Check your token and try again."
      update_state "onboard-gh-cli" "skipped"
      return 0
      ;;
    2)
      printf "\n  ${CYAN}Running: gh auth login${RESET}\n\n"
      if gh auth login 2>&1; then
        if detect_gh_auth >/dev/null 2>&1; then
          success_msg "GitHub CLI authenticated"
          update_state "onboard-gh-cli" "authed"
          return 0
        fi
      fi
      warn_msg "GitHub auth did not complete. You can retry later."
      update_state "onboard-gh-cli" "skipped"
      return 0
      ;;
    *)
      update_state "onboard-gh-cli" "skipped"
      return 0
      ;;
  esac
}

# ============================================================================
# Step 5: Claude Code Settings (MCP Server Config)
# ============================================================================

step_5_claude_settings() {
  printf "\n${BOLD}  Step 5: Configure Claude Code Settings${RESET}\n"
  printf "  ${DIM}Sets up the spawn MCP server so Claude can control SPAWN.${RESET}\n"

  if detect_claude_settings >/dev/null 2>&1; then
    success_msg "Claude settings already configured with spawn MCP server"
    update_state "onboard-claude-settings" "configured"
    return 0
  fi

  local settings_file="$HOME/.claude/settings.json"
  local token="$DASHBOARD_TOKEN"

  if [[ -z "$token" ]]; then
    error_msg "DASHBOARD_TOKEN not found in $DAEMON_DIR/.env"
    printf "  Cannot configure MCP server without the dashboard token.\n"
    return 1
  fi

  # Detect spawn-mcp URL — prefer localhost
  local mcp_url="http://localhost:4000/api/channels/mcp-proxy"
  # If spawn-mcp is running on its own port, use that
  if curl -sf "http://localhost:5020/mcp" >/dev/null 2>&1; then
    mcp_url="http://localhost:5020/mcp"
  fi

  info_msg "MCP endpoint: $mcp_url"

  # Build the spawn MCP server config
  local spawn_mcp_config
  spawn_mcp_config=$(cat <<MCPJSON
{
  "type": "streamableHttp",
  "url": "$mcp_url",
  "headers": {
    "Authorization": "Bearer $token"
  }
}
MCPJSON
)

  mkdir -p "$HOME/.claude"

  if [[ -f "$settings_file" ]]; then
    # Merge into existing settings
    if command -v jq &>/dev/null; then
      local tmp_file
      tmp_file=$(mktemp)
      jq --argjson spawn "$spawn_mcp_config" \
        '.mcpServers.spawn = $spawn' "$settings_file" > "$tmp_file" 2>/dev/null

      if [[ $? -eq 0 && -s "$tmp_file" ]]; then
        mv "$tmp_file" "$settings_file"
        success_msg "Merged spawn MCP server into existing settings"
      else
        rm -f "$tmp_file"
        error_msg "Failed to merge settings. Writing fresh config."
        _write_fresh_settings "$settings_file" "$spawn_mcp_config"
      fi
    else
      warn_msg "jq not available. Backing up and writing fresh settings."
      cp "$settings_file" "${settings_file}.bak"
      _write_fresh_settings "$settings_file" "$spawn_mcp_config"
    fi
  else
    _write_fresh_settings "$settings_file" "$spawn_mcp_config"
  fi

  # Add recommended permissions
  _add_permissions "$settings_file"

  if detect_claude_settings >/dev/null 2>&1; then
    success_msg "Claude Code settings configured"
    update_state "onboard-claude-settings" "configured"

    # Hint for OpenCode users
    local cli_bin
    cli_bin=$(detect_claude_cli 2>/dev/null) || true
    if [[ "$cli_bin" == *opencode* ]]; then
      printf "\n  ${DIM}Note: OpenCode uses opencode.json for MCP config. Copy the spawn MCP server${RESET}\n"
      printf "  ${DIM}config from ~/.claude/settings.json into opencode.json in your project root.${RESET}\n"
    fi

    return 0
  fi

  error_msg "Settings file written but verification failed"
  return 1
}

_write_fresh_settings() {
  local file="$1" mcp_config="$2"
  cat > "$file" <<SETTINGSJSON
{
  "mcpServers": {
    "spawn": $mcp_config
  }
}
SETTINGSJSON
  success_msg "Created $file with spawn MCP server"
}

_add_permissions() {
  local file="$1"
  if ! command -v jq &>/dev/null; then
    return 0
  fi

  # Add default permission settings if not present
  local tmp_file
  tmp_file=$(mktemp)
  jq '
    if .permissions == null then
      .permissions = {
        "allow": [
          "Bash(pm2 *)",
          "Bash(curl *)",
          "Bash(git *)",
          "Bash(npm *)"
        ]
      }
    else . end
  ' "$file" > "$tmp_file" 2>/dev/null

  if [[ $? -eq 0 && -s "$tmp_file" ]]; then
    mv "$tmp_file" "$file"
    info_msg "Added recommended permissions to settings"
  else
    rm -f "$tmp_file"
  fi
}

# ============================================================================
# Status Display
# ============================================================================

show_status() {
  print_header

  # Detect current state
  local s1="pending" s2="pending" s3="pending" s4="pending" s5="pending"

  # Step 1: Daemon
  if curl -sf "$DAEMON_URL/health" >/dev/null 2>&1; then
    s1="complete"
  fi

  # Step 2: Claude CLI
  if detect_claude_cli >/dev/null 2>&1; then
    s2="complete"
  fi

  # Step 3: Claude Auth
  if detect_claude_auth >/dev/null 2>&1; then
    s3="complete"
  fi

  # Step 4: GitHub CLI
  if detect_gh_auth >/dev/null 2>&1; then
    s4="complete"
  else
    # Check if skipped in daemon config
    local gh_state
    gh_state=$(curl -sf "$DAEMON_URL/api/onboard/status" \
      -H "Authorization: Bearer $DASHBOARD_TOKEN" 2>/dev/null | \
      jq -r '.steps[] | select(.name == "gh-cli") | .status' 2>/dev/null || true)
    if [[ "$gh_state" == "skipped" ]]; then
      s4="skipped"
    fi
  fi

  # Step 5: Claude Settings
  if detect_claude_settings >/dev/null 2>&1; then
    s5="complete"
  fi

  print_step 1 "Daemon Health Check" "$s1" "yes"
  print_step 2 "Claude Code CLI" "$s2" "yes"
  print_step 3 "Claude Code Auth" "$s3" "yes"
  print_step 4 "GitHub CLI" "$s4" "no"
  print_step 5 "Claude Settings" "$s5" "yes"

  # Overall status
  local required_done=0
  [[ "$s1" == "complete" ]] && required_done=$((required_done + 1))
  [[ "$s2" == "complete" ]] && required_done=$((required_done + 1))
  [[ "$s3" == "complete" ]] && required_done=$((required_done + 1))
  [[ "$s5" == "complete" ]] && required_done=$((required_done + 1))

  printf "\n"
  if [[ $required_done -eq 4 ]]; then
    printf "  ${GREEN}${BOLD}All required steps complete!${RESET} SPAWN is ready.\n"
  else
    printf "  ${YELLOW}%d/4 required steps complete.${RESET} Run ${CYAN}bash onboard.sh${RESET} to continue.\n" "$required_done"
  fi
  printf "\n"
}

# ============================================================================
# Reset
# ============================================================================

do_reset() {
  printf "  Resetting onboarding state...\n"
  for key in onboard-status onboard-claude-cli onboard-claude-auth \
             onboard-gh-cli onboard-claude-settings \
             onboard-started-at onboard-completed-at; do
    update_state "$key" ""
  done
  success_msg "Onboarding state reset. Run ${CYAN}bash onboard.sh${RESET} to start over."
}

# ============================================================================
# Main
# ============================================================================

main() {
  local mode="run"
  local target_step=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status|-s)  mode="status"; shift ;;
      --step)       mode="step"; target_step="$2"; shift 2 ;;
      --reset)      mode="reset"; shift ;;
      --help|-h)
        printf "Usage: bash onboard.sh [OPTIONS]\n\n"
        printf "Options:\n"
        printf "  --status, -s     Show onboarding status\n"
        printf "  --step N         Run specific step (1-5)\n"
        printf "  --reset          Reset onboarding state\n"
        printf "  --help, -h       Show this help\n"
        return 0
        ;;
      *) printf "Unknown option: %s\n" "$1"; return 1 ;;
    esac
  done

  case "$mode" in
    status)
      show_status
      return 0
      ;;
    reset)
      do_reset
      return 0
      ;;
    step)
      case "$target_step" in
        1) step_1_health ;;
        2) step_2_claude_cli ;;
        3) step_3_claude_auth ;;
        4) step_4_gh_auth ;;
        5) step_5_claude_settings ;;
        *) error_msg "Invalid step: $target_step (valid: 1-5)"; return 1 ;;
      esac
      return $?
      ;;
  esac

  # Full interactive run
  print_header
  printf "  ${DIM}This wizard will set up SPAWN's AI capabilities.${RESET}\n"
  printf "  ${DIM}Steps can be re-run safely — completed steps are skipped.${RESET}\n"

  # Step 1: Health
  if ! curl -sf "$DAEMON_URL/health" >/dev/null 2>&1; then
    step_1_health || {
      error_msg "Daemon must be running to continue. Fix and re-run."
      return 1
    }
  else
    printf "\n  ${GREEN}[x]${RESET} ${BOLD}Step 1${RESET}: Daemon health check ${GREEN}OK${RESET}\n"
    update_state "onboard-status" "in-progress"
  fi

  # Step 2: Claude CLI
  if detect_claude_cli >/dev/null 2>&1; then
    local v
    v=$(claude --version 2>/dev/null || echo "?")
    printf "  ${GREEN}[x]${RESET} ${BOLD}Step 2${RESET}: Claude Code CLI ${GREEN}installed${RESET} (v$v)\n"
    update_state "onboard-claude-cli" "installed"
  else
    step_2_claude_cli || {
      warn_msg "Claude CLI not installed. Continuing anyway..."
    }
  fi

  # Step 3: Claude Auth
  if detect_claude_auth >/dev/null 2>&1; then
    local method
    method=$(detect_claude_auth)
    printf "  ${GREEN}[x]${RESET} ${BOLD}Step 3${RESET}: Claude Code auth ${GREEN}$method${RESET}\n"
    update_state "onboard-claude-auth" "authed"
  else
    step_3_claude_auth || {
      warn_msg "Claude not authenticated. AI sessions won't work until this is done."
    }
  fi

  # Step 4: GitHub CLI (optional)
  if detect_gh_auth >/dev/null 2>&1; then
    local ghuser
    ghuser=$(detect_gh_auth)
    printf "  ${GREEN}[x]${RESET} ${BOLD}Step 4${RESET}: GitHub CLI ${GREEN}$ghuser${RESET}\n"
    update_state "onboard-gh-cli" "authed"
  else
    step_4_gh_auth
  fi

  # Step 5: Claude Settings
  if detect_claude_settings >/dev/null 2>&1; then
    printf "  ${GREEN}[x]${RESET} ${BOLD}Step 5${RESET}: Claude settings ${GREEN}configured${RESET}\n"
    update_state "onboard-claude-settings" "configured"
  else
    step_5_claude_settings || {
      warn_msg "Claude settings not configured. MCP integration won't work."
    }
  fi

  # Final summary
  printf "\n${BOLD}  ─────────────────────────────────────${RESET}\n"

  local all_ok=true
  detect_claude_cli >/dev/null 2>&1 || all_ok=false
  detect_claude_auth >/dev/null 2>&1 || all_ok=false
  detect_claude_settings >/dev/null 2>&1 || all_ok=false

  if $all_ok; then
    printf "\n  ${GREEN}${BOLD}Onboarding complete!${RESET}\n\n"
    printf "  SPAWN is fully configured and ready to use.\n"
    printf "  Open the dashboard to start building:\n\n"

    # Try to detect the base URL
    local base_url
    base_url=$(grep '^SCWS_BASE_URL=' "$DAEMON_DIR/.env" 2>/dev/null | cut -d= -f2-)
    if [[ -n "$base_url" ]]; then
      printf "    ${CYAN}${base_url}${RESET}\n\n"
    else
      printf "    ${CYAN}http://localhost:4000${RESET}\n\n"
    fi

    update_state "onboard-status" "complete"
    update_state "onboard-completed-at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    printf "\n  ${YELLOW}${BOLD}Onboarding incomplete.${RESET}\n\n"
    printf "  Some required steps are not done. Run again:\n"
    printf "    ${CYAN}bash onboard.sh${RESET}\n\n"
    printf "  Or check status:\n"
    printf "    ${CYAN}bash onboard.sh --status${RESET}\n\n"
  fi
}

main "$@"
