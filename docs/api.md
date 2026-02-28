# REST API Reference

All `/api/*` endpoints require authentication via `Authorization: Bearer <DASHBOARD_TOKEN>` header.

SSE endpoints (`/stream`) also accept `?token=<DASHBOARD_TOKEN>` query parameter since EventSource can't set custom headers.

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Returns `{ status, uptime, timestamp }` |

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create a project |
| GET | `/api/projects/:name` | Get project by name |
| PATCH | `/api/projects/:name` | Update project fields |
| DELETE | `/api/projects/:name` | Delete project (stops PM2, removes files, drops DB) |
| POST | `/api/projects/:name/start` | Start project via PM2 |
| POST | `/api/projects/:name/stop` | Stop project via PM2 |
| POST | `/api/projects/:name/restart` | Restart project via PM2 |
| POST | `/api/projects/:name/build` | Run build command (npm install + build) |
| GET | `/api/projects/:name/logs` | Get PM2 logs. Query: `?lines=50` |

### POST /api/projects — Body

```json
{
  "name": "my-project",
  "displayName": "My Project",
  "framework": "express",
  "description": "Optional description",
  "gitRepo": "https://github.com/user/repo",
  "needsDb": true
}
```

- `name`: lowercase alphanumeric with hyphens, required
- `displayName`: human-readable name, required
- `framework`: `express` (default), `nextjs`, `static`
- `needsDb`: creates a PostgreSQL database for the project

## Claude CLI

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects/:name/claude` | Run Claude synchronously (legacy) |
| GET | `/api/projects/:name/claude/runs` | List runs for a project. Query: `?limit=20` |
| GET | `/api/projects/:name/claude/runs/:runId` | Get a specific run |
| POST | `/api/claude/run` | Start a Claude run (async, returns runId) |
| GET | `/api/claude/stream/:runId` | SSE stream of Claude output |
| POST | `/api/claude/abort/:runId` | Abort a running Claude session |
| GET | `/api/claude/active` | List currently active runs |
| GET | `/api/claude/runs` | List all runs. Query: `?limit=50&offset=0` |
| GET | `/api/claude/runs/:runId` | Get a specific run by ID |
| GET | `/api/claude/sessions` | List Claude sessions (grouped by sessionId) |

### POST /api/claude/run — Body

```json
{
  "projectName": "my-project",
  "prompt": "Add error handling to the API routes",
  "mode": "build",
  "continueSession": "session-id-here",
  "maxTurns": 10
}
```

- `projectName`: optional, scopes the run to a project directory
- `prompt`: required
- `mode`: `build` (default), `fix`, `review`
- `continueSession`: resume an existing session
- `maxTurns`: limit the number of Claude turns

### SSE Stream Events

```
data: { "type": "assistant", "message": { "content": [...] } }
data: { "type": "tool_use", "tool": "...", "input": {...} }
data: { "type": "tool_result", "result": "..." }
data: { "type": "done", "status": "completed", "sessionId": "...", "duration": 45 }
```

## GitHub

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects/:name/github/init` | Initialize git + create GitHub repo |
| POST | `/api/projects/:name/github/clone` | Clone a repo into the project directory |
| POST | `/api/projects/:name/github/push` | Commit and push to GitHub |
| POST | `/api/projects/:name/github/pull` | Pull latest from GitHub |
| GET | `/api/github/repos` | List authenticated user's GitHub repos. Query: `?limit=30` |

### POST /api/projects/:name/github/init — Body

```json
{ "repoName": "my-repo", "isPrivate": true }
```

### POST /api/projects/:name/github/push — Body

```json
{ "message": "feat: add error handling" }
```

## Deploy

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects/:name/deploy` | Deploy project to a remote target |

### Body

```json
{ "targetName": "production-vps" }
```

Deploy targets are configured per-project in the `deploy_targets` JSON field.

## Import

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/import` | Import a project from a Git URL |

### Body

```json
{ "repoUrl": "https://github.com/user/repo" }
```

Clones the repo, detects framework, assigns a port, configures nginx, and registers the project.

## Live Log Streaming

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/:name/logs/stream` | SSE stream of PM2 logs (stdout + stderr) |

Requires token via query param: `?token=<DASHBOARD_TOKEN>`.

```
data: { "type": "log", "text": "Server started on port 5001" }
data: { "type": "error", "text": "Error: connection refused" }
```

## MCP Server Management

Manages Claude CLI's `~/.claude/settings.json` MCP server configurations.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcp/servers` | List all MCP servers (auth headers sanitized) |
| POST | `/api/mcp/servers` | Add a new MCP server |
| PATCH | `/api/mcp/servers/:name` | Update MCP server config |
| DELETE | `/api/mcp/servers/:name` | Remove MCP server |
| POST | `/api/mcp/servers/:name/test` | Test MCP server connection |
| GET | `/api/mcp/servers/:name/tools` | List tools exposed by an MCP server |
| GET | `/api/mcp/config/project/:name` | Get per-project MCP overrides |
| PATCH | `/api/mcp/config/project/:name` | Set per-project MCP overrides |

### POST /api/mcp/servers — Body

```json
{
  "name": "my-server",
  "type": "streamableHttp",
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer token" }
}
```

Supported types: `streamableHttp`, `stdio`.

## Channels (Notifications)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels` | List all channels (configs sanitized) |
| POST | `/api/channels` | Create a channel (validates credentials) |
| PATCH | `/api/channels/:id` | Update channel name, enabled, or config |
| DELETE | `/api/channels/:id` | Delete a channel |
| POST | `/api/channels/:id/test` | Send a test notification |
| POST | `/api/channels/:id/verify-telegram` | Set chat ID and verify Telegram channel |
| GET | `/api/notifications` | Notification log. Query: `?limit=50` |
| GET | `/api/channels/config/rules` | Get notification rules |
| PATCH | `/api/channels/config/rules` | Update notification rules |
| GET | `/api/channels/mcp-proxy` | Proxy to remote MCP server's channel list |

### POST /api/channels — Telegram

```json
{
  "type": "telegram",
  "name": "My Bot",
  "config": { "botToken": "123456:ABC-DEF..." }
}
```

Validates bot token via Telegram `getMe` API. Returns with `botUsername` populated. Channel is `verified: 0` until a chat ID is set via the verify endpoint.

### POST /api/channels — Email (AgentMail)

```json
{
  "type": "email",
  "name": "Alerts Email",
  "config": {
    "apiKey": "am_...",
    "inboxId": "inbox-uuid",
    "recipientEmail": "you@example.com"
  }
}
```

Validates inbox via AgentMail API. Email channels are immediately verified.

### POST /api/channels/:id/verify-telegram — Body

```json
{ "chatId": "-1001234567890" }
```

Sends a confirmation message to the chat. On success, marks channel as verified + connected.

### PATCH /api/channels/config/rules — Body

```json
{
  "build_failed": true,
  "build_succeeded": false,
  "project_started": false,
  "project_stopped": false,
  "project_crashed": true,
  "claude_completed": true,
  "claude_failed": true,
  "system_health": true
}
```

### Notification Events

| Event | Default | Trigger |
|-------|---------|---------|
| `build_failed` | On | Project build fails |
| `build_succeeded` | Off | Project build succeeds |
| `project_started` | Off | Project started via PM2 |
| `project_stopped` | Off | Project stopped via PM2 |
| `project_crashed` | On | Project process crashes |
| `claude_completed` | On | Claude run finishes successfully |
| `claude_failed` | On | Claude run fails |
| `system_health` | On | System health issues detected |

## System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/system` | Disk, memory, uptime, project counts, daemon info |
| GET | `/api/system/pm2` | PM2 process list (name, pid, status, cpu, memory, restarts) |
| GET | `/api/activity` | Activity log. Query: `?limit=50` |

### GET /api/system — Response

```json
{
  "disk": "Filesystem  Size  Used  Avail  Use%  Mounted on\n/dev/...  58G  12G  44G  22%  /",
  "memory": "              total  used  free  shared  buff/cache  available\nMem:  7856  1234  ...",
  "uptime": "up 12 days, 3 hours",
  "projects": { "total": 3, "running": 2 },
  "daemon": { "uptime": 86400, "pid": 1234, "nodeVersion": "v20.18.0" }
}
```

## WebSocket Terminal

The terminal uses WebSocket, not REST. Connect to `ws://host/terminal?token=<DASHBOARD_TOKEN>`.

Messages (JSON):

```json
// Client → Server
{ "type": "data", "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 40 }

// Server → Client
{ "type": "data", "data": "output text here" }
{ "type": "exit", "code": 0 }
```

Max 3 concurrent terminal sessions. Idle timeout: 30 minutes.
