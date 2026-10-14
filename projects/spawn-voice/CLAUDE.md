# spawn-voice

Local speech-to-text for the SPAWN dashboard's voice dictation. The dashboard
streams microphone audio here over a WebSocket; whisper.cpp transcribes it on
the Pi and live/final text goes back. Audio never leaves the machine, and it
works in any browser (Brave included — the browser's own Web Speech API does
not work in Brave/Firefox, which is why this exists).

## Using it (dashboard side)
- Open the dashboard on HTTPS (`https://spawn.tail852587.ts.net:8443/`) — browsers
  only allow the mic in a secure context. nginx `security-headers.conf` must
  send `Permissions-Policy: microphone=(self)`.
- **Hold Ctrl** (≥350 ms) = push-to-talk. **Double-tap Ctrl** = lock on;
  double-tap again = off. Ctrl combined with any other key/mouse is ignored.
- Live words show in an overlay at the top of the terminal (no focus/pointer
  capture); each finished phrase is typed into the focused/visible terminal
  (main terminal or any Claude/project session) **without Enter**.
- Client code: `daemon/dist/dashboard.html`, search `// ── Voice dictation`.
  It starts this project via `POST /api/projects/spawn-voice/start` when the
  socket can't connect, and keeps the socket open 5 min after use.

## Service
- **Port**: 5049 (registry), nginx `/spawn-voice/` → `127.0.0.1:5049/` (WebSocket upgrade)
- **Process**: started by the daemon as PM2 `scws-spawn-voice` (entryFile `server.cjs`).
  On demand only — not in the boot baseline; the watchdog idle-stops it after 30 min of 0% CPU.
- **Child**: `whisper.cpp/build/bin/whisper-server` on `127.0.0.1:15049` (PORT+10000), model kept loaded (~260 MB RSS).
- **Endpoints**: `GET /health` (no auth, no secrets) · `WS /ws?token=<DASHBOARD_TOKEN>`
  (token re-read from `daemon/.env` per connection, timing-safe compare).
- **Protocol**: client sends 16 kHz mono Int16 LE binary frames plus JSON
  `start` / `stop` / `cancel`; server sends `ready`, `interim`, `final`, `done`, `error`.
- **Env**: `WHISPER_MODEL` (default `base.en`), `WHISPER_THREADS` (default 4).

## How transcription works (server.cjs)
- Energy VAD on 20 ms frames (adaptive noise floor, 300 ms pre-roll). A phrase
  ends after 850 ms of quiet (or 25 s max). Trailing silence is trimmed before
  sending — long silence sends whisper into repetition loops.
- **Interim** (live preview, ~every 600 ms): shrunken encoder window
  (`audio_ctx` = max(512, 50/s + 128)), no temperature fallback — ~0.3–0.6 s.
  Skipped while a final is pending.
- **Final** (typed text): full `audio_ctx` 1500 with fallback — ~1.8–2.2 s on
  a Pi 5. Shrunken windows were measurably worse/loop-prone on short phrases
  (benchmarks 2026-10-14), so don't shrink finals to chase latency.
- Every request has a time budget; a runaway decode SIGKILLs whisper-server,
  which is respawned in ~0.3 s.
- Prompt = small vocab hint (SPAWN, Claude, nginx, PM2…) + last 300 chars of this connection's text.

## Setup (fresh instance)
```bash
bash /var/www/scws/projects/spawn-voice/setup.sh      # builds whisper-server, fetches models/ggml-base.en.bin, npm install
# then register: POST /api/projects {name:"spawn-voice",displayName:"SPAWN Voice",framework:"express"}
# PATCH {entryFile:"server.cjs"}, port must match nginx/projects/spawn-voice.conf
```
`whisper.cpp/`, `models/`, `node_modules/` are gitignored (built per machine/arch).

## Tests
```bash
node test/stream-sample.cjs wss://spawn.tail852587.ts.net:8443/spawn-voice/ws   # protocol + timing
python3 test/make-fake-mic.py && node test/browser-gestures.cjs ~/voice-fakemic.wav   # full browser path, all Ctrl gestures
```
