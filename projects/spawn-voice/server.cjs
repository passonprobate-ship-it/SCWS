// spawn-voice — local speech-to-text for SPAWN dashboard voice dictation.
//
// The dashboard streams 16 kHz mono Int16 PCM over a WebSocket (/ws, reached
// as /spawn-voice/ws through nginx). An energy VAD splits it into phrases; the
// open phrase is re-transcribed about every INTERIM_MS for live text, and a
// phrase is finalized after SILENCE_MS of quiet. Transcription is done by a
// child whisper.cpp `whisper-server` holding the model in memory on
// 127.0.0.1:<PORT+10000>. Audio never leaves the machine.
//
// Protocol (client → server): binary PCM frames, {"type":"start"},
//   {"type":"stop"} (finish the open phrase, then "done"), {"type":"cancel"}.
// Server → client: {"type":"ready"}, {"type":"interim","text"},
//   {"type":"final","text"}, {"type":"done"}, {"type":"error","message"}.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 5049);
const MODEL = process.env.WHISPER_MODEL || "base.en";
const THREADS = Number(process.env.WHISPER_THREADS || 4);
const WHISPER_PORT = PORT + 10000;
const ROOT = __dirname;
const WHISPER_BIN = path.join(ROOT, "whisper.cpp/build/bin/whisper-server");
const MODEL_PATH = path.join(ROOT, "models", `ggml-${MODEL}.bin`);
const DAEMON_ENV = "/var/www/scws/daemon/.env";

const RATE = 16000;
const FRAME = 320;                 // 20 ms VAD frame
const PREROLL_MS = 300;            // audio kept from just before speech starts
const SILENCE_MS = 850;            // quiet that ends a phrase
const MIN_SPEECH_MS = 250;         // shorter blips are dropped
const MAX_PHRASE_MS = 25000;       // whisper's window is 30 s
const INTERIM_MS = 600;
const SPEECH_RMS_MIN = 0.012;
const VOCAB = "SPAWN, Claude, nginx, PM2, Postgres, dashboard, TypeScript, npm, repo, commit.";

function log(msg) { console.log(new Date().toISOString() + " " + msg); }

// ── Auth: the dashboard's own bearer token, re-read so rotation just works ──
function checkToken(given) {
  if (!given) return false;
  let expected = "";
  try {
    const m = fs.readFileSync(DAEMON_ENV, "utf8").match(/^DASHBOARD_TOKEN=(.*)$/m);
    expected = m ? m[1].trim() : "";
  } catch { return false; }
  if (!expected || Buffer.byteLength(given) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// ── whisper-server child ──────────────────────────────────────────
let whisper = null;
let whisperReady = false;
let readyWaiters = [];
let stopping = false;

function startWhisper() {
  if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(MODEL_PATH)) {
    log(`whisper binary or model missing — run: bash ${ROOT}/setup.sh`);
    return;
  }
  whisperReady = false;
  whisper = spawn(WHISPER_BIN, ["-m", MODEL_PATH, "-t", String(THREADS), "--host", "127.0.0.1",
    "--port", String(WHISPER_PORT), "-nt"], { stdio: ["ignore", "ignore", "pipe"] });
  whisper.stderr.on("data", (d) => {
    const s = d.toString();
    if (/error|fail/i.test(s)) process.stderr.write(s);
  });
  whisper.on("exit", (code, sig) => {
    whisperReady = false;
    whisper = null;
    if (stopping) return;
    log(`whisper-server exited (${code ?? sig}) — restarting`);
    setTimeout(startWhisper, sig === "SIGKILL" ? 100 : 2000);
  });
  pollReady();
}

function pollReady() {
  const req = http.get({ host: "127.0.0.1", port: WHISPER_PORT, path: "/", timeout: 1000 }, (res) => {
    res.resume();
    whisperReady = true;
    log(`whisper-server ready (model ${MODEL}, ${THREADS} threads)`);
    readyWaiters.splice(0).forEach((f) => f());
  });
  req.on("error", () => { if (whisper) setTimeout(pollReady, 300); });
  req.on("timeout", () => req.destroy());
}

function whenReady() {
  return whisperReady ? Promise.resolve() : new Promise((r) => readyWaiters.push(r));
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// whisper.cpp runs one inference at a time; keep requests in a single queue
let whisperChain = Promise.resolve();
// kind "interim": shrunken encoder window (fast, occasionally garbled — it's a
// preview). kind "final": whisper's full 30 s window, which is what makes the
// typed text accurate; shrunken windows can loop or drop words.
function transcribe(pcm, prompt, kind) {
  const job = whisperChain.then(async () => {
    await whenReady();
    const secs = pcm.length / 2 / RATE;
    const form = new FormData();
    form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "a.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("no_timestamps", "true");
    const final = kind === "final";
    // 50 ctx per second of audio; 1500 = the full window
    form.append("audio_ctx", String(final ? 1500 : Math.min(1500, Math.max(512, Math.ceil(secs * 50) + 128))));
    form.append("prompt", prompt);
    if (!final) form.append("temperature_inc", "0"); // finals keep the fallback re-decode that escapes repetition
    form.append("suppress_nst", "true");
    // A decode that runs away (repeating itself) would block every request
    // behind it, so past the budget the child is killed and restarted (~0.3 s).
    const budget = final ? 6000 + secs * 500 : 1200 + secs * 150;
    const timer = setTimeout(() => {
      log(`${kind} inference over ${budget} ms for ${secs.toFixed(1)} s of audio — restarting whisper-server`);
      if (whisper) { whisperReady = false; whisper.kill("SIGKILL"); }
    }, budget);
    try {
      const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`whisper ${res.status}`);
      return cleanText((await res.json()).text || "", secs);
    } finally {
      clearTimeout(timer);
    }
  });
  whisperChain = job.catch(() => {});
  return job;
}

const HALLUCINATIONS = new Set(["you", "thank you", "thanks for watching", "thank you for watching", "bye"]);
function cleanText(t, secs) {
  t = t.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")       // [BLANK_AUDIO], (music), *sigh*
       .replace(/(\b.{6,}?)(?:[\s,.]+\1\b){2,}/gi, "$1")      // "ask what … ask what … ask what …"
       .replace(/\s+/g, " ").trim();
  if (secs < 2 && HALLUCINATIONS.has(t.toLowerCase().replace(/[.!?,]/g, ""))) return "";
  return t;
}

// ── Per-connection phrase tracking ────────────────────────────────
function session(ws) {
  let frames = [];               // Int16 frames of the open phrase (incl. pre-roll)
  let lastSpeech = -1;           // index in frames of the latest speech frame
  let preroll = [];
  let speaking = false;
  let speechMs = 0, silenceMs = 0, phraseMs = 0;
  let noise = 0.005;
  let carry = Buffer.alloc(0);
  let phraseId = 0;
  let interimBusy = false, lastInterim = 0;
  let finals = Promise.resolve();
  let finalsPending = 0;         // live previews wait while a phrase is being finalized
  let context = "";

  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const prompt = () => (VOCAB + " " + context).slice(-400);

  // Phrase audio up to 200 ms past the last speech — long trailing silence is
  // what sends whisper into repetition loops
  function speechAudio() { return Buffer.concat(frames.slice(0, lastSpeech + 11)); }

  function reset() {
    frames = []; lastSpeech = -1; speaking = false; speechMs = silenceMs = phraseMs = 0;
  }

  function finalize() {
    phraseId++;
    const enough = speechMs >= MIN_SPEECH_MS;
    const pcm = speechAudio();
    reset();
    if (!enough) return;
    finalsPending++;
    finals = finals.then(() => transcribe(pcm, prompt(), "final").finally(() => finalsPending--).then((text) => {
      if (text) { context = (context + " " + text).slice(-300); send({ type: "final", text }); }
      else send({ type: "interim", text: "" });
    }).catch((e) => send({ type: "error", message: "Transcription failed: " + e.message })));
  }

  function interim() {
    if (!speaking || interimBusy || finalsPending || Date.now() - lastInterim < INTERIM_MS || phraseMs < 500) return;
    interimBusy = true;
    lastInterim = Date.now();
    const id = phraseId;
    transcribe(speechAudio(), prompt(), "interim")
      .then((text) => { if (id === phraseId) send({ type: "interim", text }); })
      .catch(() => {})
      .finally(() => { interimBusy = false; });
  }

  function onFrame(f) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) { const v = f.readInt16LE(i * 2) / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / FRAME);
    const isSpeech = rms > Math.max(SPEECH_RMS_MIN, noise * 3);
    if (!isSpeech) noise = noise * 0.97 + rms * 0.03;

    if (!speaking) {
      preroll.push(f);
      if (preroll.length > PREROLL_MS / 20) preroll.shift();
      if (isSpeech) { speaking = true; frames = preroll; preroll = []; lastSpeech = frames.length - 1; speechMs = 20; phraseMs = frames.length * 20; silenceMs = 0; }
      return;
    }
    frames.push(f);
    phraseMs += 20;
    if (isSpeech) { speechMs += 20; silenceMs = 0; lastSpeech = frames.length - 1; } else silenceMs += 20;
    if (silenceMs >= SILENCE_MS || phraseMs >= MAX_PHRASE_MS) finalize();
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      let buf = carry.length ? Buffer.concat([carry, data]) : data;
      const whole = buf.length - (buf.length % (FRAME * 2));
      for (let o = 0; o < whole; o += FRAME * 2) onFrame(buf.subarray(o, o + FRAME * 2));
      carry = Buffer.from(buf.subarray(whole));
      interim();
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "start") { reset(); preroll = []; carry = Buffer.alloc(0); phraseId++; }
    else if (msg.type === "cancel") { reset(); preroll = []; phraseId++; }
    else if (msg.type === "stop") {
      if (speaking) finalize();
      preroll = [];
      finals.then(() => send({ type: "done" }));
    }
  });

  whenReady().then(() => send({ type: "ready" }));
}

// ── HTTP + WebSocket ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "spawn-voice", model: MODEL, whisperReady }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws" || !checkToken(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => session(ws));
});

server.listen(PORT, "127.0.0.1", () => log(`spawn-voice listening on 127.0.0.1:${PORT}`));
startWhisper();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stopping = true; if (whisper) whisper.kill("SIGTERM"); process.exit(0); });
}
