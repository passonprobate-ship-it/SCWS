#!/usr/bin/env bash
# onboard-detect.sh — Pure detection functions for SPAWN onboarding
# No side effects. Each function returns 0 (found) or 1 (not found).
# Output goes to stdout for callers that need version/path info.

# Detect Claude Code CLI installation
# Returns 0 if found, 1 if not
# Prints path to claude binary on stdout
detect_claude_cli() {
  local claude_bin=""

  # Check common install locations
  if command -v claude &>/dev/null; then
    claude_bin="$(command -v claude)"
  elif [[ -x "$HOME/.local/bin/claude" ]]; then
    claude_bin="$HOME/.local/bin/claude"
  elif [[ -x "/usr/local/bin/claude" ]]; then
    claude_bin="/usr/local/bin/claude"
  fi

  if [[ -n "$claude_bin" ]]; then
    printf '%s' "$claude_bin"
    return 0
  fi
  return 1
}

# Detect Claude Code authentication status
# Returns 0 if authenticated, 1 if not
# Prints auth method (oauth/api-key) on stdout
detect_claude_auth() {
  local creds_file="$HOME/.claude/.credentials.json"

  if [[ ! -f "$creds_file" ]]; then
    return 1
  fi

  # Check for OAuth token
  if command -v jq &>/dev/null; then
    local has_oauth
    has_oauth=$(jq -r '.accessToken // .claudeAiOauth // empty' "$creds_file" 2>/dev/null)
    if [[ -n "$has_oauth" ]]; then
      printf 'oauth'
      return 0
    fi

    # Check for API key
    local has_api_key
    has_api_key=$(jq -r '.apiKey // empty' "$creds_file" 2>/dev/null)
    if [[ -n "$has_api_key" ]]; then
      printf 'api-key'
      return 0
    fi
  else
    # Fallback without jq — check file has content beyond {}
    local size
    size=$(wc -c < "$creds_file" 2>/dev/null)
    if [[ "$size" -gt 5 ]]; then
      printf 'unknown'
      return 0
    fi
  fi

  return 1
}

# Detect GitHub CLI authentication status
# Returns 0 if authenticated, 1 if not
# Prints GitHub username on stdout
detect_gh_auth() {
  if ! command -v gh &>/dev/null; then
    return 1
  fi

  local gh_user
  gh_user=$(gh auth status 2>&1)
  if [[ $? -eq 0 ]]; then
    # Extract username from status output
    local username
    username=$(printf '%s' "$gh_user" | grep -oP 'Logged in to github.com account \K\S+' 2>/dev/null || \
               printf '%s' "$gh_user" | grep -oP 'account \K\S+' 2>/dev/null)
    printf '%s' "${username:-authenticated}"
    return 0
  fi

  return 1
}

# Detect Claude Code settings with spawn MCP server configured
# Returns 0 if configured, 1 if not
# Prints "configured" or details on stdout
detect_claude_settings() {
  local settings_file="$HOME/.claude/settings.json"

  if [[ ! -f "$settings_file" ]]; then
    return 1
  fi

  if command -v jq &>/dev/null; then
    # Check if mcpServers.spawn exists
    local has_spawn
    has_spawn=$(jq -r '.mcpServers.spawn // empty' "$settings_file" 2>/dev/null)
    if [[ -n "$has_spawn" && "$has_spawn" != "null" ]]; then
      printf 'configured'
      return 0
    fi
  else
    # Fallback: grep for spawn MCP config
    if grep -q '"spawn"' "$settings_file" 2>/dev/null && \
       grep -q 'mcpServers' "$settings_file" 2>/dev/null; then
      printf 'configured'
      return 0
    fi
  fi

  return 1
}
