---
name: new-project
description: Create a new SPAWN hosted project end-to-end — port assignment, scaffold, PM2 with heap caps, nginx, daemon registration, docs, git. Use whenever the user asks to build/create/scaffold a new project on SPAWN.
---

# New Project — the enforced checklist

Read `/var/www/scws/docs/PROJECT-PLAYBOOK.md` (Recipe 1, plus Recipe 2 if the project needs a database) for exact payloads and templates. This skill is the ordered checklist; the playbook is the reference. Every step below is mandatory — skipping one creates the classic failure modes (port conflicts, 502s, prefix bugs, registry drift).

## 0. Plan

Save the plan to spawn-mcp: `spawn_remember` key `active-task-<name>`, with steps and status. Update it at milestones.

## 1. Port

Next free port in **5001–5099**. Check BOTH the registry and the OS — a port can be taken by an unregistered process:

```bash
TOKEN=$(grep -oP '^DASHBOARD_TOKEN=\K.*' /var/www/scws/daemon/.env | tr -d '[:space:]')
curl -s http://localhost:4000/api/projects -H 'Authorization: Bearer '"$TOKEN"'' | jq -r '.[].port' | sort -n
ss -tlnp | grep -oP ':50\d\d' | sort -u
```

## 2. Scaffold

`projects/<name>/` with code, deps, and `.env` containing `PORT=<port>` and `BASE_URL=/<name>`. The nginx template strips the `/<name>/` prefix (`proxy_pass` with trailing slash) and passes `X-Base-Path: /<name>` — the app must serve its routes at `/` and use BASE_URL/X-Base-Path when generating absolute links/assets.

## 3. PM2 with heap cap

```bash
pm2 start <entry> --name <name> --cwd /var/www/scws/projects/<name> \
  --node-args="--env-file=.env --max-old-space-size=<MB>" --max-memory-restart <MB+~20%>M
```

Heap size per the playbook table (64 MB tiny → 256 MB heavy). PM2 name = project name exactly, no prefix.

## 4. nginx

Copy the template from the playbook into `nginx/projects/<name>.conf`, then `sudo nginx -t && sudo nginx -s reload`. **Skip entirely for `framework=android`** — no HTTP server, and the daemon skips it too.

## 5. Register with the daemon

`POST /api/projects` with `{ name, port, framework, description }`, then `PATCH /api/projects/<name>` for `status`, `gitRepo`, `gitBranch`, `deployTargets`.

## 6. Verify both paths

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/     # direct
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/<name>/      # through nginx
pm2 logs <name> --lines 15 --nostream
```

Both must answer. 502 through nginx + 200 direct = wrong port in the conf.

## 7. Document

Write `projects/<name>/CLAUDE.md`: what it is, port, DB (if any), endpoints, how to run/build. Future sessions depend on this.

## 8. Boot baseline — do NOT pm2 save

The PM2 dump stays core-only (boot philosophy). The project runs now; the daemon can always restart it from the registry. Only add it to the baseline if the user explicitly wants it to survive reboots.

## 9. Git

Commit the project plus its nginx conf to the monorepo and push. Mark the spawn-mcp task complete.
