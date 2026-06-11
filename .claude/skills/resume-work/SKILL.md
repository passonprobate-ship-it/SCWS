---
name: resume-work
description: Recall all in-flight tasks from spawn-mcp memory and pick up where the last session left off. Use at session start, after a disconnect/daemon restart, or when the user asks "where were we", "what's in progress", "continue what you were doing".
---

# Resume Work — recover state from spawn-mcp

Sessions die (disconnects, daemon restarts, context limits). The `active-task-*` keys in spawn-mcp are the crash log. This skill turns them back into running work.

## 1. List active tasks

Token lives in `~/.claude/settings.json` under `mcpServers.spawn.headers.Authorization`:

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('/home/codeman/.claude/settings.json'))['mcpServers']['spawn']['headers']['Authorization'].replace('Bearer ',''))")
curl -s -X POST "http://localhost:5020/mcp" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"spawn_list_memories","arguments":{}}}'
```

Responses arrive as SSE (`event: message` / `data: {...}`) — parse the `data:` line. Filter for keys starting `active-task-`. If spawn-mcp is down (it's SPAWN core, so it shouldn't be), `pm2 logs spawn-mcp --lines 20 --nostream` and fix that first.

## 2. Recall each active task

```bash
curl -s ... -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"spawn_recall","arguments":{"key":"active-task-<x>"}}}'
```

## 3. Verify against reality

Memory says what was *planned*; check what actually *happened* since it was written:

```bash
git -C /var/www/scws log --oneline -5 && git -C /var/www/scws status --short
pm2 jlist | jq -r '.[] | [.name, .pm2_env.status] | @tsv'
```

A task note saying "step 3 of 6" with commits landed after its timestamp may really be at step 5 — trust git over the note. Uncommitted changes matching a paused task = that task is mid-flight, highest priority.

## 4. Report and resume

Report to the user: each in-progress/paused task, its last known state, what reality-checking showed, and what the next concrete step is. Then:

- **One clear in-flight task** → resume it (update its memory key to "resuming, step N").
- **Multiple candidates** → ask which one.
- **All complete/stale** → say so; `spawn_forget` keys whose work is verifiably done and committed (tell the user which you cleaned up).
