import { readFile, writeFile, rename } from "fs/promises";
import { log } from "./logger.js";

const USER_HOME = process.env.HOME || "/home/codeman";
const SETTINGS_PATH = `${USER_HOME}/.claude/settings.json`;

// ── Types ────────────────────────────────────────────────────────

export interface McpServerConfig {
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ClaudeSettings {
  permissions?: { allow?: string[] };
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

// ── Write mutex (prevent concurrent settings.json corruption) ────

let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

// ── Settings I/O ─────────────────────────────────────────────────

export async function readClaudeSettings(): Promise<ClaudeSettings> {
  const raw = await readFile(SETTINGS_PATH, "utf-8");
  return JSON.parse(raw);
}

export async function writeClaudeSettings(settings: ClaudeSettings): Promise<void> {
  return withLock(async () => {
    const json = JSON.stringify(settings, null, 2) + "\n";
    const tmpPath = SETTINGS_PATH + ".tmp";
    await writeFile(tmpPath, json, "utf-8");
    await rename(tmpPath, SETTINGS_PATH);
    log("Updated ~/.claude/settings.json", "mcp");
  });
}

// ── Sanitization ─────────────────────────────────────────────────

export function sanitizeServerConfig(config: McpServerConfig): McpServerConfig {
  const clean = { ...config };
  if (clean.headers) {
    clean.headers = { ...clean.headers };
    for (const key of Object.keys(clean.headers)) {
      if (key.toLowerCase() === "authorization") {
        const val = clean.headers[key];
        clean.headers[key] = val.startsWith("Bearer ") ? "Bearer ***" : "***";
      }
    }
  }
  return clean;
}

export function sanitizeAllServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    result[name] = sanitizeServerConfig(config);
  }
  return result;
}

// ── MCP Protocol Helpers ─────────────────────────────────────────

export async function testMcpConnection(
  config: McpServerConfig,
): Promise<{ ok: boolean; latencyMs?: number; serverInfo?: unknown; error?: string }> {
  if (config.type !== "streamableHttp" || !config.url) {
    return { ok: false, error: `Cannot test ${config.type} servers remotely` };
  }

  const start = Date.now();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(config.headers || {}),
    };

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "spawn-dashboard", version: "1.0.0" },
      },
    });

    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    // Handle SSE responses (some servers return text/event-stream)
    const contentType = res.headers.get("content-type") || "";
    let data: any;

    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      const jsonLine = text.split("\n").find(l => l.startsWith("data: "));
      if (jsonLine) {
        data = JSON.parse(jsonLine.slice(6));
      } else {
        return { ok: true, latencyMs, serverInfo: { note: "SSE response, no data parsed" } };
      }
    } else {
      data = await res.json();
    }

    if (data.error) {
      return { ok: false, latencyMs, error: data.error.message || JSON.stringify(data.error) };
    }

    return { ok: true, latencyMs, serverInfo: data.result };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

export async function listMcpTools(
  config: McpServerConfig,
): Promise<{ tools: any[]; error?: string }> {
  if (config.type !== "streamableHttp" || !config.url) {
    return { tools: [], error: `Cannot list tools for ${config.type} servers` };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(config.headers || {}),
  };

  try {
    // Step 1: Initialize
    const initRes = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "spawn-dashboard", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!initRes.ok) return { tools: [], error: `Init failed: HTTP ${initRes.status}` };

    // Extract session ID (check both cases)
    const sessionId =
      initRes.headers.get("Mcp-Session-Id") ||
      initRes.headers.get("mcp-session-id");

    const sessionHeaders = sessionId
      ? { ...headers, "Mcp-Session-Id": sessionId }
      : headers;

    // Handle SSE init response — consume it
    const initContentType = initRes.headers.get("content-type") || "";
    if (initContentType.includes("text/event-stream")) {
      await initRes.text(); // consume SSE body
    } else {
      await initRes.json(); // consume JSON body
    }

    // Step 2: Send initialized notification
    await fetch(config.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(5_000),
    });

    // Step 3: List tools
    const toolsRes = await fetch(config.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!toolsRes.ok) return { tools: [], error: `Tools list failed: HTTP ${toolsRes.status}` };

    const toolsContentType = toolsRes.headers.get("content-type") || "";
    let data: any;

    if (toolsContentType.includes("text/event-stream")) {
      const text = await toolsRes.text();
      const jsonLine = text.split("\n").find(l => l.startsWith("data: "));
      if (jsonLine) {
        data = JSON.parse(jsonLine.slice(6));
      } else {
        return { tools: [], error: "SSE response but no data line found" };
      }
    } else {
      data = await toolsRes.json();
    }

    return { tools: data.result?.tools || [] };
  } catch (err: any) {
    return { tools: [], error: err.message };
  }
}
