# hello-spawn

Example project showcasing SPAWN conventions. A polished Express 5 API with a dark-themed landing page.

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev        # tsx hot-reload
npm run build      # esbuild -> dist/index.js
npm start          # production
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /hello-spawn/ | Landing page (HTML) |
| GET | /hello-spawn/api/health | Health check |
| GET | /hello-spawn/api/echo?message=hi | Echo with metadata |
| POST | /hello-spawn/api/reverse | Reverse text (JSON body) |
| GET | /hello-spawn/api/random | Random programming quote |

## Stack

- Express 5, TypeScript, esbuild
- Single-file SPA landing page (inline CSS, no deps)
- PM2-ready, nginx-ready

## Conventions Demonstrated

- PORT + BASE_URL from env
- esbuild bundler in script/build.ts
- Clean error handling with typed responses
- Self-contained HTML landing page with dark theme
