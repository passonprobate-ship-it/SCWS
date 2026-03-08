# Security Model

SPAWN is an early-stage, self-programming autonomous server platform. This document describes the current security architecture honestly — including known limitations. Transparency is more valuable than overclaiming.

## Architecture Overview

SPAWN uses a single-daemon architecture (Express 5 on port 4000) that manages projects, databases, and AI sessions. All API access requires a bearer token. The dashboard is a single-page application served by the daemon behind nginx.

### Authentication

- **Bearer token auth** on all API endpoints. Tokens are compared using Node.js `crypto.timingSafeEqual` with a buffer-length guard to prevent timing attacks.
- **Query token restriction**: The `?token=` query parameter is only accepted on SSE/stream endpoints (`/logs/stream`, `/claude/stream`) where `EventSource` API cannot set headers. All other HTTP routes require the `Authorization: Bearer` header. This prevents token leakage via browser history, server logs, and referer headers.
- **WebSocket auth**: Terminal WebSocket connections use query tokens (WebSocket API limitation) — handled separately in `terminal.ts`.
- **Dashboard access** uses the same bearer token mechanism.
- **No user accounts or RBAC** — there is a single admin token. You either have full access or no access.

### Transport and Headers

- **CORS** origin whitelist restricts which domains can make cross-origin requests to the API.
- **Content Security Policy**: `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net` — no `'unsafe-eval'`. `'unsafe-inline'` is required because the dashboard is a single-file SPA with inline scripts. All CDN scripts have **SRI integrity hashes** (`sha384`) and `crossorigin="anonymous"` to prevent CDN tampering.
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- **Trust proxy** is enabled (`app.set("trust proxy", 1)`) so Express sees real client IPs behind nginx for accurate rate limiting.

### Rate Limiting

- `express-rate-limit` is applied to sensitive routes:
  - `/api/claude/run`: 10 requests/minute
  - `/api/upload-zip`: 5 requests/minute
  - `/api/files/upload`: 5 requests/minute
  - `/api/*` (catch-all): 200 requests/minute

### Input Validation

- Max length enforcement on string inputs.
- Regex validation for project names, identifiers, and addresses.
- NaN checks on numeric inputs.
- Shell commands use `child_process.execFile` (not `exec`) to avoid shell injection.
- **Upload security**: ZIP uploads check for path traversal entries and reject symlinks (via `lstat()`). File uploads resolve symlinks with `realpath()` before the `startsWith()` path check to prevent symlink-based directory escapes.
- **Fail-fast startup**: Database connection is validated at module load — daemon exits immediately if credentials are wrong rather than failing on first query.

## What IS Isolated

- **Project directories**: Each project lives in its own directory under `/var/www/scws/projects/`. Projects do not share code directories.
- **PM2 process separation**: Each project runs as its own OS process managed by PM2, with per-process heap caps (`--max-old-space-size`) and memory restart limits (`--max-memory-restart`).
- **nginx routing**: Each project gets its own auto-generated nginx location block. Requests are reverse-proxied to project-specific ports (5001-5099).
- **API authentication**: Every API request requires a valid bearer token. Unauthenticated requests are rejected.

## What is NOT Isolated (Known Limitations)

These are real limitations of the current architecture. We document them so operators can make informed decisions.

- **Single Linux user**: All projects and the daemon run as the same OS user. A compromised project has filesystem access to other projects and the daemon itself.
- **Shared database credentials**: All projects share the same PostgreSQL user (`scws`). A project with database access could query or modify another project's database.
- **No network isolation**: Projects can communicate freely with each other over localhost. There are no firewall rules or network namespaces separating project processes.
- **AI sessions have full access**: Claude and OpenCode sessions run with full filesystem and shell access within the SPAWN workspace. AI-generated code is not sandboxed before execution.
- **Dashboard is all-or-nothing**: The dashboard provides full terminal access, project management, and daemon control. Anyone with the bearer token has complete control over the server. Securing access to the dashboard (port 80 / the nginx frontend) is critical.
- **Single admin token**: There is no role-based access control. The bearer token grants full administrative access.

## Recommendations for Operators

1. **Restrict network access**: Use [Tailscale](https://tailscale.com/) or a VPN to limit who can reach the dashboard. Do not expose the dashboard to the open internet without additional access controls.
2. **Use TLS**: For any internet-facing deployment, configure SSL/TLS via Let's Encrypt. nginx makes this straightforward with certbot.
3. **Do not expose port 4000 directly**: Always access the daemon through nginx, which provides rate limiting, header injection, and TLS termination.
4. **Review AI-generated code**: SPAWN's AI sessions can write and execute arbitrary code. Review what gets deployed, especially for internet-facing projects.
5. **Keep auto-updates enabled**: The hourly auto-update mechanism pulls security fixes from the upstream repository.
6. **Rotate the bearer token** periodically, especially if it may have been exposed.
7. **Monitor PM2 logs**: Check `pm2 logs` regularly for unexpected activity.

## Roadmap

These improvements are planned but not yet implemented:

- **Per-project Linux user separation**: Run each project under a dedicated `spawn-runner-<project>` user with restricted filesystem permissions.
- **Per-project database users**: Create isolated PostgreSQL roles per project, each scoped to its own database.
- **Network isolation between projects**: Use network namespaces or firewall rules to prevent inter-project communication by default.
- **Default-private networking**: Tailscale-only access by default, with explicit opt-in for public exposure.
- **Role-based access control**: Multiple user accounts with scoped permissions (read-only, project-specific, admin).

## Responsible Disclosure

If you discover a security vulnerability in SPAWN, please report it privately:

- **Email**: [security@spawn-server.dev](mailto:security@spawn-server.dev)
- **GitHub Security Advisory**: [Open an advisory](https://github.com/passonprobate-ship-it/SCWS/security/advisories/new)

We aim to respond within **72 hours** and will work with you to understand and address the issue before any public disclosure.

Please do **not** open public GitHub issues for security vulnerabilities.
