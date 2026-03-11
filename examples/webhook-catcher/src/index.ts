import express, { Request, Response, NextFunction } from "express";
import pg from "pg";

const PORT = parseInt(process.env.PORT || "5050", 10);
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://scws:password@localhost:5432/webhook_catcher_db";
const MAX_BODY_BYTES = 100 * 1024; // 100KB limit

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT,
        headers JSONB,
        query JSONB,
        body JSONB,
        source_ip TEXT,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("[webhook-catcher] Database table ready");
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateBody(body: unknown): unknown {
  const raw = JSON.stringify(body);
  if (raw && raw.length > MAX_BODY_BYTES) {
    return { _truncated: true, _originalSize: raw.length, preview: raw.slice(0, 2048) };
  }
  return body;
}

function parseBody(req: Request): unknown {
  const raw = (req as any).body;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "object") return truncateBody(raw);
  if (typeof raw === "string") {
    try {
      return truncateBody(JSON.parse(raw));
    } catch {
      return truncateBody(raw);
    }
  }
  return truncateBody(raw);
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Webhook Catcher</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    background: #0a0a0f;
    color: #e0e0e8;
    min-height: 100vh;
  }

  .container {
    display: grid;
    grid-template-rows: auto auto 1fr;
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 20px;
    gap: 20px;
    min-height: 100vh;
  }

  /* Header */
  .header {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 16px;
  }

  .header h1 {
    font-size: 1.6rem;
    font-weight: 700;
    color: #ff6b35;
    letter-spacing: -0.5px;
  }

  .header h1 span { color: #666; font-weight: 400; }

  .header-stats {
    display: flex;
    gap: 20px;
    font-size: 0.85rem;
    color: #888;
  }

  .header-stats .stat-value {
    color: #ff6b35;
    font-weight: 600;
    font-size: 1.1rem;
  }

  /* URL Card */
  .url-card {
    background: #12121a;
    border: 1px solid #1e1e2e;
    border-radius: 10px;
    padding: 16px 20px;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 12px;
  }

  .url-card label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    margin-bottom: 4px;
    display: block;
  }

  .url-card .url {
    font-size: 0.95rem;
    color: #ff6b35;
    word-break: break-all;
    user-select: all;
  }

  .url-card .hint {
    font-size: 0.72rem;
    color: #555;
    margin-top: 4px;
  }

  .btn-clear {
    background: #1a1012;
    border: 1px solid #3a1515;
    color: #e55;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-clear:hover { background: #2a1515; border-color: #e55; }

  /* Table */
  .table-wrap {
    background: #12121a;
    border: 1px solid #1e1e2e;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .table-scroll {
    overflow-y: auto;
    flex: 1;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  thead th {
    position: sticky;
    top: 0;
    background: #16161f;
    padding: 10px 14px;
    text-align: left;
    font-weight: 600;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #666;
    border-bottom: 1px solid #1e1e2e;
    z-index: 2;
  }

  tbody tr {
    cursor: pointer;
    transition: background 0.1s;
  }

  tbody tr:nth-child(4n+1), tbody tr:nth-child(4n+2) { background: transparent; }
  tbody tr:nth-child(4n+3), tbody tr:nth-child(4n+4) { background: #0e0e15; }

  tbody tr:hover { background: #1a1a28 !important; }

  tbody td {
    padding: 9px 14px;
    border-bottom: 1px solid #111118;
    vertical-align: top;
    max-width: 0;
  }

  .td-time { white-space: nowrap; color: #777; font-size: 0.78rem; width: 160px; min-width: 160px; }
  .td-method { width: 80px; min-width: 80px; }
  .td-path { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-ip { color: #777; white-space: nowrap; width: 130px; min-width: 130px; }
  .td-body { color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Method badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 700;
    font-size: 0.7rem;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .badge-GET    { background: #0a2a1a; color: #3ddc84; border: 1px solid #1a4a2a; }
  .badge-POST   { background: #0a1a2e; color: #64b5f6; border: 1px solid #1a2a4e; }
  .badge-PUT    { background: #2a2a0a; color: #ffd54f; border: 1px solid #4a4a1a; }
  .badge-DELETE { background: #2a0a0a; color: #ef5350; border: 1px solid #4a1a1a; }
  .badge-PATCH  { background: #1a0a2a; color: #ce93d8; border: 1px solid #2a1a4a; }

  /* Expanded row */
  .detail-row td {
    padding: 0 !important;
    border-bottom: 1px solid #1e1e2e;
    background: #0c0c14 !important;
  }

  .detail-content {
    padding: 16px 20px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .detail-section h4 {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #ff6b35;
    margin-bottom: 8px;
  }

  .json-block {
    background: #08080e;
    border: 1px solid #1a1a25;
    border-radius: 6px;
    padding: 12px;
    overflow-x: auto;
    font-size: 0.78rem;
    line-height: 1.5;
    max-height: 300px;
    overflow-y: auto;
  }

  /* JSON syntax colors */
  .json-key { color: #82aaff; }
  .json-string { color: #c3e88d; }
  .json-number { color: #f78c6c; }
  .json-bool { color: #ff6b35; }
  .json-null { color: #666; font-style: italic; }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: #444;
  }

  .empty-state .icon { font-size: 2.5rem; margin-bottom: 12px; }
  .empty-state p { font-size: 0.9rem; }

  /* Live indicator */
  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3ddc84;
    margin-right: 6px;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .live-label { font-size: 0.75rem; color: #3ddc84; }

  /* Responsive */
  @media (max-width: 768px) {
    .header { grid-template-columns: 1fr; }
    .header-stats { justify-content: flex-start; }
    .url-card { grid-template-columns: 1fr; }
    .detail-content { grid-template-columns: 1fr; }
    .td-ip { display: none; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Webhook Catcher <span>// SPAWN Example</span></h1>
    <div class="header-stats">
      <div><span class="live-dot"></span><span class="live-label">Live</span></div>
      <div>Total: <span class="stat-value" id="stat-total">0</span></div>
      <div>24h: <span class="stat-value" id="stat-24h">0</span></div>
      <div>Last: <span class="stat-value" id="stat-last">never</span></div>
    </div>
  </div>

  <div class="url-card">
    <div>
      <label>Your Webhook URL (catch-all)</label>
      <div class="url" id="webhook-url"></div>
      <div class="hint">Send any HTTP method to this URL. Append any path after /catch/. All requests are logged.</div>
    </div>
    <button class="btn-clear" onclick="clearAll()">Clear All</button>
  </div>

  <div class="table-wrap">
    <div class="table-scroll" id="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Method</th>
            <th>Path</th>
            <th>Source IP</th>
            <th>Body Preview</th>
          </tr>
        </thead>
        <tbody id="webhook-tbody">
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
const BASE = "${BASE_URL}";
let expanded = null;

document.getElementById("webhook-url").textContent = location.origin + BASE + "/catch/your-endpoint";

async function api(path) {
  const r = await fetch(BASE + path);
  return r.json();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function syntaxHighlight(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (!json) return '<span class="json-null">null</span>';
  return json.replace(/("(\\\\u[a-fA-F0-9]{4}|\\\\[^u]|[^\\\\"])*")(\\s*:)?|\\b(true|false)\\b|\\bnull\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g,
    function(match, str, _, colon, boolVal) {
      let cls = "json-number";
      if (str) {
        cls = colon ? "json-key" : "json-string";
      } else if (boolVal !== undefined) {
        cls = "json-bool";
      } else if (match === "null") {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + escapeHtml(match) + '</span>';
    }
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " "
    + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function fmtAgo(iso) {
  if (!iso) return "never";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec/60) + "m ago";
  if (sec < 86400) return Math.floor(sec/3600) + "h ago";
  return Math.floor(sec/86400) + "d ago";
}

function bodyPreview(body) {
  if (body === null || body === undefined) return '<span style="color:#444">-</span>';
  const s = typeof body === "string" ? body : JSON.stringify(body);
  if (s.length > 80) return escapeHtml(s.slice(0, 80)) + "...";
  return escapeHtml(s);
}

function toggleRow(id, row) {
  const existing = document.getElementById("detail-" + id);
  if (existing) {
    existing.remove();
    expanded = null;
    return;
  }
  // collapse previous
  if (expanded !== null) {
    const prev = document.getElementById("detail-" + expanded);
    if (prev) prev.remove();
  }
  expanded = id;
  // fetch full webhook
  api("/api/webhooks/" + id).then(wh => {
    const tr = document.createElement("tr");
    tr.className = "detail-row";
    tr.id = "detail-" + id;
    tr.innerHTML = '<td colspan="5"><div class="detail-content">'
      + '<div class="detail-section"><h4>Headers</h4><pre class="json-block">' + syntaxHighlight(wh.headers) + '</pre></div>'
      + '<div class="detail-section"><h4>Body</h4><pre class="json-block">' + syntaxHighlight(wh.body) + '</pre></div>'
      + '<div class="detail-section"><h4>Query Params</h4><pre class="json-block">' + syntaxHighlight(wh.query) + '</pre></div>'
      + '<div class="detail-section"><h4>Meta</h4><pre class="json-block">' + syntaxHighlight({id: wh.id, method: wh.method, path: wh.path, source_ip: wh.source_ip, received_at: wh.received_at}) + '</pre></div>'
      + '</div></td>';
    row.parentNode.insertBefore(tr, row.nextSibling);
  });
}

async function refresh() {
  try {
    const [webhooks, stats] = await Promise.all([
      api("/api/webhooks?limit=100"),
      api("/api/stats")
    ]);

    document.getElementById("stat-total").textContent = stats.total;
    document.getElementById("stat-24h").textContent = stats.last24h;
    document.getElementById("stat-last").textContent = webhooks.length > 0 ? fmtAgo(webhooks[0].received_at) : "never";

    const tbody = document.getElementById("webhook-tbody");
    if (webhooks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon">&#x1f4e1;</div><p>No webhooks received yet.<br>Send a request to the catch-all URL above to get started.</p></div></td></tr>';
      return;
    }

    let html = "";
    for (const wh of webhooks) {
      const methodCls = "badge badge-" + (wh.method || "GET");
      html += '<tr onclick="toggleRow(' + wh.id + ', this)">'
        + '<td class="td-time">' + fmtTime(wh.received_at) + '</td>'
        + '<td class="td-method"><span class="' + methodCls + '">' + escapeHtml(wh.method) + '</span></td>'
        + '<td class="td-path">' + escapeHtml(wh.path || "/") + '</td>'
        + '<td class="td-ip">' + escapeHtml(wh.source_ip || "-") + '</td>'
        + '<td class="td-body">' + bodyPreview(wh.body) + '</td>'
        + '</tr>';
      // re-insert expanded detail if still open
      if (expanded === wh.id) {
        html += '<tr class="detail-row" id="detail-' + wh.id + '"><td colspan="5"><div class="detail-content"><div class="detail-section"><h4>Loading...</h4></div></div></td></tr>';
      }
    }
    tbody.innerHTML = html;

    // re-fetch expanded detail
    if (expanded !== null) {
      const detailRow = document.getElementById("detail-" + expanded);
      if (detailRow) {
        api("/api/webhooks/" + expanded).then(wh => {
          if (!wh || !wh.id) { expanded = null; return; }
          detailRow.innerHTML = '<td colspan="5"><div class="detail-content">'
            + '<div class="detail-section"><h4>Headers</h4><pre class="json-block">' + syntaxHighlight(wh.headers) + '</pre></div>'
            + '<div class="detail-section"><h4>Body</h4><pre class="json-block">' + syntaxHighlight(wh.body) + '</pre></div>'
            + '<div class="detail-section"><h4>Query Params</h4><pre class="json-block">' + syntaxHighlight(wh.query) + '</pre></div>'
            + '<div class="detail-section"><h4>Meta</h4><pre class="json-block">' + syntaxHighlight({id: wh.id, method: wh.method, path: wh.path, source_ip: wh.source_ip, received_at: wh.received_at}) + '</pre></div>'
            + '</div></td>';
        });
      }
    }
  } catch (e) {
    console.error("Refresh failed:", e);
  }
}

async function clearAll() {
  if (!confirm("Delete all captured webhooks?")) return;
  await fetch(BASE + "/api/webhooks", { method: "DELETE" });
  expanded = null;
  refresh();
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Parse bodies of any content type
app.use(express.json({ limit: "200kb", type: "*/*" }));

// ---------------------------------------------------------------------------
// Routes (all prefixed with BASE_URL)
// ---------------------------------------------------------------------------

// Dashboard
app.get(`${BASE_URL}/`, asyncHandler(async (_req: Request, res: Response) => {
  res.type("html").send(dashboardHtml());
}));

// Stats
app.get(`${BASE_URL}/api/stats`, asyncHandler(async (_req: Request, res: Response) => {
  const totalResult = await pool.query("SELECT COUNT(*)::int AS total FROM webhooks");
  const last24hResult = await pool.query(
    "SELECT COUNT(*)::int AS count FROM webhooks WHERE received_at > NOW() - INTERVAL '24 hours'"
  );
  const byMethodResult = await pool.query(
    "SELECT method, COUNT(*)::int AS count FROM webhooks GROUP BY method ORDER BY count DESC"
  );

  const byMethod: Record<string, number> = {};
  for (const row of byMethodResult.rows) {
    byMethod[row.method] = row.count;
  }

  res.json({
    total: totalResult.rows[0].total,
    last24h: last24hResult.rows[0].count,
    byMethod,
  });
}));

// List webhooks
app.get(`${BASE_URL}/api/webhooks`, asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit) || "100", 10) || 100, 1), 1000);
  const result = await pool.query(
    "SELECT id, method, path, headers, query, body, source_ip, received_at FROM webhooks ORDER BY received_at DESC LIMIT $1",
    [limit]
  );
  res.json(result.rows);
}));

// Get single webhook
app.get(`${BASE_URL}/api/webhooks/:id`, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  const result = await pool.query(
    "SELECT id, method, path, headers, query, body, source_ip, received_at FROM webhooks WHERE id = $1",
    [id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }
  res.json(result.rows[0]);
}));

// Clear all webhooks
app.delete(`${BASE_URL}/api/webhooks`, asyncHandler(async (_req: Request, res: Response) => {
  await pool.query("DELETE FROM webhooks");
  res.json({ ok: true });
}));

// Catch-all: log any incoming webhook
app.all(`${BASE_URL}/catch/*`, asyncHandler(async (req: Request, res: Response) => {
  const catchPrefix = `${BASE_URL}/catch`;
  const path = req.path.slice(catchPrefix.length) || "/";
  const body = parseBody(req);
  const headers = req.headers as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  const sourceIp = req.ip || req.socket?.remoteAddress || "unknown";

  const result = await pool.query(
    `INSERT INTO webhooks (method, path, headers, query, body, source_ip)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.method, path, JSON.stringify(headers), JSON.stringify(query), JSON.stringify(body), sourceIp]
  );

  const id = result.rows[0].id;
  console.log(`[webhook-catcher] ${req.method} ${path} from ${sourceIp} -> id=${id}`);

  res.json({ ok: true, id });
}));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`[webhook-catcher] Listening on port ${PORT}`);
    console.log(`[webhook-catcher] Dashboard: http://localhost:${PORT}${BASE_URL}/`);
    console.log(`[webhook-catcher] Catch URL: http://localhost:${PORT}${BASE_URL}/catch/*`);
  });
}

main().catch((err) => {
  console.error("[webhook-catcher] Fatal:", err);
  process.exit(1);
});
