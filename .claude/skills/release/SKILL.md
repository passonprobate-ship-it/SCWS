---
name: release
description: Cut a SPAWN release — preflight checks, VERSION bump, stamp-version.sh, release commit, git tag, push. Use when the user says "cut a release", "bump the version", "release vX.Y.Z", or after a feature lands that should ship to all instances.
---

# Release — version, stamp, tag, push

A release is what every other SPAWN instance pulls via hourly auto-update. The repo must be ship-shape **before** the version moves.

## 1. Preflight (all must pass)

```bash
cd /var/www/scws
git status --short                      # must be empty
git branch --show-current               # must be master
git fetch && git status -sb | head -1   # must not be behind origin
daemon/node_modules/.bin/tsc --noEmit -p tsconfig.json   # 0 errors
node --check daemon/dist/index.cjs      # bundle parses
```

If daemon source (`daemon/*.ts`, `shared/schema.ts`) changed since `daemon/dist/index.cjs` was last built, run `/daemon-deploy` first — releasing a stale bundle ships old code to every instance:

```bash
git log -1 --format=%ci -- daemon/ shared/ ':!daemon/dist'   # source last touched
git log -1 --format=%ci -- daemon/dist/index.cjs             # bundle last built
```

## 2. Bump VERSION (semver)

`printf '1.2.0' > VERSION` — no trailing newline issues (stamp script strips whitespace, but use printf anyway). Patch = fixes only, minor = features, major = breaking changes to bootstrap/API/schema.

## 3. Stamp

```bash
bash scripts/stamp-version.sh
```

Writes `spawn-version.json` (committed) and `.spawn-instance.json` (gitignored). Expected output: `Stamped vX.Y.Z (<hash>) at <date>`. Note: the gitHash stamped here is the **pre-release-commit** hash — that's the known convention, don't chase it.

## 4. Commit, tag, push

```bash
git add VERSION spawn-version.json
git commit -m "release: vX.Y.Z — <one-line summary of what shipped>"
git tag vX.Y.Z
git push origin master --tags
```

## 5. Confirm

```bash
git log --oneline -1 && git tag --contains HEAD
```

Other instances pick the release up within the hour (auto-update cron, ff-only). Nothing to do on this instance — it's already running the code. Mention to the user which instances will receive it and that the daemon on remote instances restarts per auto-update's component-aware rules.
