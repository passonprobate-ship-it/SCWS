# static-site

Static HTML portfolio template — no build step, no server process.

## Environment
- **Base URL**: /static-site
- **Directory**: /var/www/scws/projects/static-site
- **Framework**: static
- **Process**: None (served directly by nginx)

## Key Files
- `index.html` — Single-file site with inline CSS and JS

## Rules
- All asset paths must be relative to BASE_URL (/static-site/)
- nginx serves this directory directly — no Express server needed
- Edit index.html and changes are live immediately
