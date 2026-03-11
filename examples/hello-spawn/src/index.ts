import express, { Request, Response, NextFunction } from "express";

const PORT = parseInt(process.env.PORT || "5050", 10);
const BASE_URL = process.env.BASE_URL || "/hello-spawn";
const base = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;

const app = express();
const router = express.Router();
const startTime = Date.now();

app.use(express.json());

// ---------------------------------------------------------------------------
// Programming quotes
// ---------------------------------------------------------------------------

const quotes: { text: string; author: string }[] = [
  { text: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", author: "Martin Fowler" },
  { text: "First, solve the problem. Then, write the code.", author: "John Johnson" },
  { text: "The best error message is the one that never shows up.", author: "Thomas Fuchs" },
  { text: "Code is like humor. When you have to explain it, it's bad.", author: "Cory House" },
  { text: "Simplicity is the soul of efficiency.", author: "Austin Freeman" },
  { text: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", author: "Harold Abelson" },
  { text: "The most dangerous phrase in the language is: We've always done it this way.", author: "Grace Hopper" },
  { text: "Perfection is achieved not when there is nothing more to add, but when there is nothing left to take away.", author: "Antoine de Saint-Exupery" },
  { text: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
  { text: "It works on my machine.", author: "Every Developer" },
  { text: "There are only two hard things in Computer Science: cache invalidation and naming things.", author: "Phil Karlton" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

function landingPage(): string {
  const uptime = formatUptime(uptimeSeconds());
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hello-spawn</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a26;
    --border: #1e1e2e;
    --border-glow: #00d4aa30;
    --accent: #00d4aa;
    --accent-dim: #00d4aa80;
    --text: #e0e0e6;
    --text-dim: #8888a0;
    --mono: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    line-height: 1.6;
    min-height: 100vh;
    overflow-x: hidden;
  }

  .container {
    max-width: 860px;
    margin: 0 auto;
    padding: 3rem 1.5rem 4rem;
  }

  /* Header */
  .header {
    text-align: center;
    margin-bottom: 3rem;
  }

  .header h1 {
    font-family: var(--mono);
    font-size: 2.8rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--accent);
    animation: glow 4s ease-in-out infinite;
  }

  @keyframes glow {
    0%, 100% { text-shadow: 0 0 20px #00d4aa20, 0 0 40px #00d4aa10; }
    50%      { text-shadow: 0 0 30px #00d4aa40, 0 0 60px #00d4aa20; }
  }

  .header .tagline {
    font-size: 1.05rem;
    color: var(--text-dim);
    margin-top: 0.5rem;
  }

  .meta {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin-top: 1.25rem;
    font-family: var(--mono);
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .meta .dot {
    width: 7px;
    height: 7px;
    background: var(--accent);
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
    animation: pulse 2s ease-in-out infinite;
    vertical-align: middle;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 #00d4aa60; }
    50%      { opacity: 0.7; box-shadow: 0 0 0 4px #00d4aa00; }
  }

  /* Sections */
  .section {
    margin-bottom: 2.5rem;
  }

  .section h2 {
    font-family: var(--mono);
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 1rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .section p {
    color: var(--text-dim);
    font-size: 0.95rem;
    line-height: 1.7;
  }

  /* Endpoint cards */
  .endpoints {
    display: grid;
    gap: 1rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    cursor: pointer;
    transition: all 0.25s ease;
    position: relative;
    overflow: hidden;
  }

  .card::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 10px;
    border: 1px solid transparent;
    transition: border-color 0.25s ease;
  }

  .card:hover {
    background: var(--surface-hover);
    transform: translateY(-2px);
  }

  .card:hover::before {
    border-color: var(--border-glow);
  }

  .card-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .method {
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .method.get  { background: #00d4aa18; color: #00d4aa; }
  .method.post { background: #6366f118; color: #818cf8; }

  .path {
    font-family: var(--mono);
    font-size: 0.9rem;
    color: var(--text);
  }

  .card-desc {
    font-size: 0.85rem;
    color: var(--text-dim);
    margin-bottom: 0.75rem;
  }

  .curl-box {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.9rem;
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--text-dim);
    overflow-x: auto;
    white-space: nowrap;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transition: max-height 0.3s ease, opacity 0.3s ease, margin-top 0.3s ease, padding 0.3s ease;
    margin-top: 0;
    padding: 0 0.9rem;
  }

  .card.open .curl-box {
    max-height: 60px;
    opacity: 1;
    margin-top: 0.75rem;
    padding: 0.6rem 0.9rem;
  }

  .curl-box code { flex: 1; }

  .copy-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: var(--mono);
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .copy-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* Footer */
  .footer {
    text-align: center;
    margin-top: 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--text-dim);
  }

  .footer a {
    color: var(--accent);
    text-decoration: none;
  }

  .footer a:hover { text-decoration: underline; }

  /* Response overlay */
  .response-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }

  .response-overlay.active { display: flex; }

  .response-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    max-width: 560px;
    width: 90%;
    max-height: 70vh;
    overflow-y: auto;
  }

  .response-box h3 {
    font-family: var(--mono);
    font-size: 0.9rem;
    color: var(--accent);
    margin-bottom: 1rem;
  }

  .response-box pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
    font-family: var(--mono);
    font-size: 0.82rem;
    color: var(--text);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .response-box .close-btn {
    display: block;
    margin-top: 1rem;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: var(--mono);
    font-size: 0.8rem;
    padding: 6px 16px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s ease;
    margin-left: auto;
  }

  .response-box .close-btn:hover { border-color: var(--accent); color: var(--accent); }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>hello-spawn</h1>
    <div class="tagline">A showcase Express API built on SPAWN</div>
    <div class="meta">
      <span><span class="dot"></span>running</span>
      <span>uptime: ${uptime}</span>
      <span id="clock"></span>
    </div>
  </div>

  <div class="section">
    <h2>// what is SPAWN?</h2>
    <p>
      <strong style="color:var(--text)">SPAWN</strong> (Self-Programming Autonomous Web Node)
      is an AI-powered server that writes, builds, deploys, and manages its own web projects.
      Give it a prompt, and it creates production-ready apps&mdash;complete with databases,
      reverse proxies, and process management. This example project demonstrates the
      conventions every SPAWN project follows: environment-driven config, esbuild bundling,
      PM2 process management, and nginx routing.
    </p>
  </div>

  <div class="section">
    <h2>// try the API</h2>
    <p style="margin-bottom:1rem;">Click any endpoint to reveal the curl command. Click the card header to fire a live request.</p>
    <div class="endpoints">

      <div class="card" data-url="${base}/api/health" data-method="GET">
        <div class="card-head">
          <span class="method get">GET</span>
          <span class="path">${base}/api/health</span>
        </div>
        <div class="card-desc">Health check &mdash; returns status, uptime, and timestamp.</div>
        <div class="curl-box">
          <code>curl http://localhost:${PORT}${base}/api/health</code>
          <button class="copy-btn" onclick="event.stopPropagation();copyCmd(this)">copy</button>
        </div>
      </div>

      <div class="card" data-url="${base}/api/echo?message=hello%20world" data-method="GET">
        <div class="card-head">
          <span class="method get">GET</span>
          <span class="path">${base}/api/echo?message=hello world</span>
        </div>
        <div class="card-desc">Echoes your message back with metadata.</div>
        <div class="curl-box">
          <code>curl "http://localhost:${PORT}${base}/api/echo?message=hello%20world"</code>
          <button class="copy-btn" onclick="event.stopPropagation();copyCmd(this)">copy</button>
        </div>
      </div>

      <div class="card" data-url="${base}/api/reverse" data-method="POST" data-body='{"text":"hello spawn"}'>
        <div class="card-head">
          <span class="method post">POST</span>
          <span class="path">${base}/api/reverse</span>
        </div>
        <div class="card-desc">Reverses the text you send in the JSON body.</div>
        <div class="curl-box">
          <code>curl -X POST -H "Content-Type: application/json" -d '{"text":"hello spawn"}' http://localhost:${PORT}${base}/api/reverse</code>
          <button class="copy-btn" onclick="event.stopPropagation();copyCmd(this)">copy</button>
        </div>
      </div>

      <div class="card" data-url="${base}/api/random" data-method="GET">
        <div class="card-head">
          <span class="method get">GET</span>
          <span class="path">${base}/api/random</span>
        </div>
        <div class="card-desc">Returns a random programming quote. Refresh for a new one.</div>
        <div class="curl-box">
          <code>curl http://localhost:${PORT}${base}/api/random</code>
          <button class="copy-btn" onclick="event.stopPropagation();copyCmd(this)">copy</button>
        </div>
      </div>

    </div>
  </div>

  <div class="footer">
    Built by <a href="https://github.com/passonprobate-ship-it/SCWS">SPAWN</a>
  </div>
</div>

<div class="response-overlay" id="overlay">
  <div class="response-box">
    <h3 id="resp-title">Response</h3>
    <pre id="resp-body"></pre>
    <button class="close-btn" onclick="closeOverlay()">close</button>
  </div>
</div>

<script>
  // Clock
  (function tick() {
    const el = document.getElementById("clock");
    if (el) el.textContent = new Date().toLocaleTimeString();
    setTimeout(tick, 1000);
  })();

  // Toggle curl box
  document.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".copy-btn")) return;
      card.classList.toggle("open");
    });
    // Double-click fires the request
    card.addEventListener("dblclick", async (e) => {
      if (e.target.closest(".copy-btn")) return;
      const url = card.dataset.url;
      const method = card.dataset.method;
      const body = card.dataset.body;
      try {
        const opts = { method, headers: {} };
        if (body) {
          opts.headers["Content-Type"] = "application/json";
          opts.body = body;
        }
        const r = await fetch(url, opts);
        const data = await r.json();
        showResponse(method + " " + url, JSON.stringify(data, null, 2));
      } catch (err) {
        showResponse("Error", String(err));
      }
    });
  });

  function showResponse(title, body) {
    document.getElementById("resp-title").textContent = title;
    document.getElementById("resp-body").textContent = body;
    document.getElementById("overlay").classList.add("active");
  }

  function closeOverlay() {
    document.getElementById("overlay").classList.remove("active");
  }

  document.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeOverlay();
  });

  function copyCmd(btn) {
    const code = btn.previousElementSibling.textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = "copied!";
      setTimeout(() => btn.textContent = "copy", 1500);
    });
  }
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/", (_req: Request, res: Response) => {
  res.type("html").send(landingPage());
});

router.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: uptimeSeconds(),
    uptimeFormatted: formatUptime(uptimeSeconds()),
    timestamp: new Date().toISOString(),
  });
});

router.get("/api/echo", (req: Request, res: Response) => {
  const message = req.query.message;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Missing ?message= query parameter" });
    return;
  }
  res.json({
    echo: message,
    length: message.length,
    uppercase: message.toUpperCase(),
    timestamp: new Date().toISOString(),
  });
});

router.post("/api/reverse", (req: Request, res: Response) => {
  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: 'Missing "text" field in JSON body' });
    return;
  }
  if (text.length > 10000) {
    res.status(400).json({ error: "Text too long (max 10,000 characters)" });
    return;
  }
  res.json({
    original: text,
    reversed: [...text].reverse().join(""),
    length: text.length,
    timestamp: new Date().toISOString(),
  });
});

router.get("/api/random", (_req: Request, res: Response) => {
  const quote = quotes[Math.floor(Math.random() * quotes.length)];
  res.json({
    quote: quote.text,
    author: quote.author,
    total: quotes.length,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Mount and start
// ---------------------------------------------------------------------------

app.use(base, router);

// Catch-all 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[hello-spawn] Error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[hello-spawn] Listening on port ${PORT}, base: ${base}`);
});
