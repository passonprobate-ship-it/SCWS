# spawn-mcp

Local MCP (Model Context Protocol) server for SPAWN. Gives Claude Code native tool access to SPAWN operations — no bash/curl needed for project management, system status, databases, etc.

## Architecture
- **Port**: 5020
- **Transport**: Streamable HTTP (stateless) at `/mcp`
- **Auth**: Bearer token (same as daemon DASHBOARD_TOKEN)
- **Reads**: Direct PostgreSQL queries to `scws_daemon`
- **Writes/Actions**: Proxied through daemon REST API at `localhost:4000`

## Tools (16)
- **Projects**: list, get, create, start, stop, build, logs
- **System**: system status, PM2 list
- **Database**: list databases, create database
- **Memory**: remember, recall, forget, list memories
- **Activity**: get activity log

## Key Files
- `src/index.ts` — Express + MCP server entry point
- `src/db.ts` — PostgreSQL pool
- `src/auth.ts` — Bearer token middleware
- `src/daemon-client.ts` — HTTP client for daemon API
- `src/tools/` — Tool modules (projects, system, database, memory, activity)
- `script/build.ts` — esbuild bundler

## Build & Deploy
```bash
npx tsx script/build.ts    # → dist/index.cjs
pm2 restart spawn-mcp
```

## Database
Uses `scws_daemon` DB. Added `spawn_memories` table for persistent memory.
