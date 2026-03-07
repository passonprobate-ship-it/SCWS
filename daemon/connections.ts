/**
 * Connections & Files Module
 *
 * Handles CRUD for the connections table (raw SQL, not Drizzle ORM),
 * file browsing/editing for the code editor, and Vultr VPS proxy routes.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import dns from "dns";
import https from "https";
import os from "os";
import type { Application, Request, Response } from "express";
import { Pool } from "pg";

import { pool } from "./db.js";
import { asyncHandler } from "./asyncHandler.js";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

// ── Raw SQL helper ──────────────────────────────────────────────────────

async function dbQuery(sql: string, params: any[] = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// ── Encryption helpers (AES-256-GCM) ────────────────────────────────────

const ENC_KEY_SOURCE = process.env.ENCRYPTION_KEY || process.env.DASHBOARD_TOKEN || "";
const ENC_KEY = crypto.createHash("sha256").update(ENC_KEY_SOURCE).digest();

function encryptValue(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  let enc = cipher.update(plaintext, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return "enc:" + iv.toString("hex") + ":" + tag + ":" + enc;
}

function decryptValue(ciphertext: string): string {
  if (!ciphertext || !ciphertext.startsWith("enc:")) return ciphertext;
  const parts = ciphertext.split(":");
  if (parts.length !== 4) return ciphertext;
  const iv = Buffer.from(parts[1], "hex");
  const tag = Buffer.from(parts[2], "hex");
  const enc = parts[3];
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);
  let dec = decipher.update(enc, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

// ── Sensitive key definitions per connection type ────────────────────────

const SENSITIVE_KEYS: Record<string, string[]> = {
  ssh: ["password", "privateKey", "passphrase"],
  database: ["password", "connectionString"],
  api: ["token", "password", "apiKey", "secret", "accessToken"],
  mcp: ["token", "headers"],
  voice: ["apiKey", "token"],
  custom: ["password", "token", "secret", "apiKey"],
};

function encryptConfig(type: string, config: Record<string, any>): Record<string, any> {
  const keys = SENSITIVE_KEYS[type] || SENSITIVE_KEYS.custom;
  const result = { ...config };
  for (const k of keys) {
    if (result[k] && typeof result[k] === "string" && !result[k].startsWith("enc:")) {
      result[k] = encryptValue(result[k]);
    }
  }
  return result;
}

function decryptConfig(type: string, config: Record<string, any>): Record<string, any> {
  const keys = SENSITIVE_KEYS[type] || SENSITIVE_KEYS.custom;
  const result = { ...config };
  for (const k of keys) {
    if (result[k] && typeof result[k] === "string" && result[k].startsWith("enc:")) {
      try {
        result[k] = decryptValue(result[k]);
      } catch {
        /* leave encrypted */
      }
    }
  }
  return result;
}

function maskConfig(type: string, config: Record<string, any>): Record<string, any> {
  const keys = SENSITIVE_KEYS[type] || SENSITIVE_KEYS.custom;
  const result = { ...config };
  for (const k of keys) {
    if (result[k] && typeof result[k] === "string" && result[k].length > 0) {
      result[k] = "***";
    }
  }
  return result;
}

// ── File-system path helpers ────────────────────────────────────────────

const FILES_ROOT = "/var/www/scws";
const MAX_UPLOAD = 500 * 1024 * 1024;
const DAEMON_DIR = path.join(FILES_ROOT, "daemon");

function safePath(p: string): string {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(FILES_ROOT)) {
    throw new Error("Access denied: path outside sandbox");
  }
  // Block symlinks that escape
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(FILES_ROOT)) throw new Error("Symlink escape blocked");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    // File doesn't exist yet (e.g. for mkdir/upload) - check parent
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      if (!realParent.startsWith(FILES_ROOT)) throw new Error("Symlink escape blocked");
    }
  }
  return resolved;
}

function safeWritePath(p: string): string {
  const resolved = safePath(p);
  if (resolved.startsWith(DAEMON_DIR + "/") || resolved === DAEMON_DIR) {
    throw new Error("Access denied: writes to daemon/ directory are blocked");
  }
  return resolved;
}

// ── Vultr VPS helpers ───────────────────────────────────────────────────

const vultrCache: Record<string, any> = {
  regions: null,
  plans: null,
  os: null,
  regionsAt: 0,
  plansAt: 0,
  osAt: 0,
};
const VULTR_CACHE_TTL = 3600000; // 1 hour

async function resolveVultrKey(connName?: string): Promise<string> {
  const rows = await dbQuery("SELECT * FROM connections WHERE name = $1", [connName || "vultr"]);
  if (!rows.length) throw new Error("Connection '" + (connName || "vultr") + "' not found");
  const conn = rows[0];
  const cfg = decryptConfig(conn.type, JSON.parse(conn.config));
  const key = cfg.apiKey || cfg.token || cfg.api_key;
  if (!key) throw new Error("No API key found in connection config");
  await dbQuery("UPDATE connections SET last_used_at = now() WHERE id = $1", [conn.id]);
  return key;
}

async function vultrFetch(apiKey: string, urlPath: string, opts: any = {}): Promise<any> {
  const url = "https://api.vultr.com/v2" + urlPath;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const { setDefaultResultOrder } = dns;
    const origOrder = dns.getDefaultResultOrder ? dns.getDefaultResultOrder() : null;
    if (setDefaultResultOrder) setDefaultResultOrder("ipv4first");
    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        ...opts,
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } finally {
      if (origOrder && setDefaultResultOrder) setDefaultResultOrder(origOrder);
    }
    if (res.status === 204) return { ok: true };
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const errMsg = data.error || data.message || text || "HTTP " + res.status;
      throw new Error(errMsg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ── Route registration ──────────────────────────────────────────────────

export function registerConnectionsRoutes(app: Application): void {
  // ── CONNECTIONS API ROUTES ──

  app.get(
    "/api/connections",
    asyncHandler("List connections", async (req: Request, res: Response) => {
      const rows = await dbQuery("SELECT * FROM connections ORDER BY name");
      const masked = rows.map((r: any) => {
        const cfg = JSON.parse(r.config);
        return { ...r, config: JSON.stringify(maskConfig(r.type, cfg)) };
      });
      res.json(masked);
    })
  );

  app.post(
    "/api/connections",
    asyncHandler("Create connection", async (req: Request, res: Response) => {
      const { name, type, config, description, tags } = req.body;
      if (!name || !type) {
        res.status(400).json({ error: "name and type are required" });
        return;
      }
      const validTypes = ["ssh", "database", "api", "mcp", "voice", "custom"];
      if (!validTypes.includes(type)) {
        res.status(400).json({ error: "Invalid type" });
        return;
      }
      const encCfg = encryptConfig(type, config || {});
      const rows = await dbQuery(
        `INSERT INTO connections (name, type, config, description, tags)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, type, JSON.stringify(encCfg), description || "", JSON.stringify(tags || [])]
      );
      const row = rows[0];
      row.config = JSON.stringify(maskConfig(type, JSON.parse(row.config)));
      await storage.logActivity({
        action: "connection_created",
        details: "Created " + type + " connection: " + name,
      });
      res.status(201).json(row);
    })
  );

  app.get(
    "/api/connections/by-name/:name",
    asyncHandler("Get connection by name", async (req: Request, res: Response) => {
      const name = req.params.name;
      const rows = await dbQuery("SELECT * FROM connections WHERE name = $1", [name]);
      if (!rows.length) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      const row = rows[0];
      row.config = JSON.stringify(decryptConfig(row.type, JSON.parse(row.config)));
      await dbQuery("UPDATE connections SET last_used_at = now() WHERE id = $1", [row.id]);
      res.json(row);
    })
  );

  app.patch(
    "/api/connections/:id",
    asyncHandler("Update connection", async (req: Request, res: Response) => {
      const id = req.params.id;
      const rows = await dbQuery("SELECT * FROM connections WHERE id = $1", [id]);
      if (!rows.length) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      const existing = rows[0];
      const existingCfg = JSON.parse(existing.config);
      const updates = req.body;
      const type = updates.type || existing.type;

      if (updates.config) {
        const merged: Record<string, any> = { ...existingCfg };
        for (const [k, v] of Object.entries(updates.config)) {
          if (v === "***") continue; // preserve existing encrypted value
          merged[k] = v;
        }
        const encCfg = encryptConfig(type, decryptConfig(existing.type, merged));
        updates.config = JSON.stringify(encCfg);
      }

      const setClauses: string[] = [];
      const params: any[] = [];
      let idx = 1;
      for (const field of ["name", "type", "config", "description", "tags"]) {
        if (updates[field] !== undefined) {
          setClauses.push(field + " = $" + idx);
          params.push(field === "tags" ? JSON.stringify(updates[field]) : updates[field]);
          idx++;
        }
      }
      if (!setClauses.length) {
        res.json(existing);
        return;
      }
      setClauses.push("updated_at = now()");
      params.push(id);
      const result = await dbQuery(
        "UPDATE connections SET " + setClauses.join(", ") + " WHERE id = $" + idx + " RETURNING *",
        params
      );
      const row = result[0];
      row.config = JSON.stringify(maskConfig(row.type, JSON.parse(row.config)));
      await storage.logActivity({
        action: "connection_updated",
        details: "Updated " + existing.type + " connection: " + (row.name || existing.name),
      });
      res.json(row);
    })
  );

  app.delete(
    "/api/connections/:id",
    asyncHandler("Delete connection", async (req: Request, res: Response) => {
      const id = req.params.id;
      const rows = await dbQuery("SELECT * FROM connections WHERE id = $1", [id]);
      if (!rows.length) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      await dbQuery("DELETE FROM connections WHERE id = $1", [id]);
      await storage.logActivity({
        action: "connection_deleted",
        details: "Deleted connection: " + rows[0].name,
      });
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/connections/:id/test",
    asyncHandler("Test connection", async (req: Request, res: Response) => {
      const id = req.params.id;
      const rows = await dbQuery("SELECT * FROM connections WHERE id = $1", [id]);
      if (!rows.length) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      const conn = rows[0];
      const cfg = decryptConfig(conn.type, JSON.parse(conn.config));
      let result: any = { ok: false, error: "Test not implemented for type: " + conn.type };

      try {
        if (conn.type === "ssh") {
          const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5"];
          if (cfg.port) args.push("-p", String(cfg.port));
          if (cfg.privateKey) {
            const tmpKey = "/tmp/.spawn-test-key-" + Date.now();
            fs.writeFileSync(tmpKey, cfg.privateKey, { mode: 0o600 });
            args.push("-i", tmpKey);
            args.push((cfg.user || "root") + "@" + cfg.host, "echo ok");
            try {
              const { stdout } = await execFileAsync("ssh", args, { timeout: 10000 });
              result = { ok: true, output: stdout.trim() };
            } finally {
              try {
                fs.unlinkSync(tmpKey);
              } catch {}
            }
          } else {
            result = {
              ok: false,
              error: "SSH test requires privateKey (password auth not supported in test)",
            };
          }
        } else if (conn.type === "database") {
          const dbType = cfg.dbType || "postgresql";
          if (dbType === "postgresql" || dbType === "postgres") {
            const connStr =
              cfg.connectionString ||
              "postgresql://" +
                (cfg.user || "postgres") +
                ":" +
                (cfg.password || "") +
                "@" +
                (cfg.host || "localhost") +
                ":" +
                (cfg.port || 5432) +
                "/" +
                (cfg.database || "postgres");
            const testPool = new Pool({
              connectionString: connStr,
              connectionTimeoutMillis: 5000,
            });
            try {
              await testPool.query("SELECT 1 as ok");
              result = { ok: true, output: "Connected to " + dbType };
            } finally {
              await testPool.end();
            }
          } else if (dbType === "redis") {
            const { stdout } = await execFileAsync(
              "redis-cli",
              ["-h", cfg.host || "localhost", "-p", String(cfg.port || 6379), "ping"],
              { timeout: 5000 }
            );
            result = { ok: stdout.trim() === "PONG", output: stdout.trim() };
          } else {
            result = { ok: false, error: "Unsupported database type: " + dbType };
          }
        } else if (conn.type === "api") {
          const baseUrl = cfg.url || cfg.endpoint;
          if (!baseUrl) {
            result = { ok: false, error: "No URL configured" };
          } else {
            const testUrl = cfg.testPath
              ? baseUrl.replace(/\/+$/, "") + cfg.testPath
              : baseUrl;
            const headers: Record<string, string> = {};
            if (cfg.token) headers["Authorization"] = "Bearer " + cfg.token;
            if (cfg.apiKey) {
              headers["X-API-Key"] = cfg.apiKey;
              if (!cfg.token) headers["Authorization"] = "Bearer " + cfg.apiKey;
            }
            if (cfg.headers && typeof cfg.headers === "object") Object.assign(headers, cfg.headers);

            const fetchOpts: any = {
              headers,
              signal: AbortSignal.timeout(10000),
            };

            let resp: globalThis.Response;
            if (testUrl.includes("vultr.com")) {
              const { setDefaultResultOrder } = dns;
              const origOrder = dns.getDefaultResultOrder ? dns.getDefaultResultOrder() : null;
              if (setDefaultResultOrder) setDefaultResultOrder("ipv4first");
              try {
                resp = await fetch(testUrl, fetchOpts);
              } finally {
                if (origOrder && setDefaultResultOrder) setDefaultResultOrder(origOrder);
              }
            } else {
              resp = await fetch(testUrl, fetchOpts);
            }

            if (resp.status >= 500) {
              result = {
                ok: false,
                status: resp.status,
                output: "HTTP " + resp.status + " " + resp.statusText,
              };
            } else {
              result = {
                ok: true,
                status: resp.status,
                output: "API reachable (HTTP " + resp.status + ")",
              };
            }
          }
        } else if (conn.type === "mcp") {
          const url = cfg.url;
          if (!url) {
            result = { ok: false, error: "No URL configured" };
          } else {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (cfg.token) headers["Authorization"] = "Bearer " + cfg.token;
            const resp = await fetch(url, {
              headers,
              signal: AbortSignal.timeout(10000),
            });
            result = {
              ok: resp.ok,
              status: resp.status,
              output: resp.ok ? "MCP server reachable" : "HTTP " + resp.status,
            };
          }
        }
      } catch (err: any) {
        result = { ok: false, error: err.message || String(err) };
      }

      await dbQuery("UPDATE connections SET last_used_at = now() WHERE id = $1", [id]);
      res.json(result);
    })
  );

  // ── FILES API ROUTES ──

  app.get(
    "/api/files/list",
    asyncHandler("List directory", async (req: Request, res: Response) => {
      const dirPath = safePath((req.query.path as string) || FILES_ROOT);
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      const items: any[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dirPath, entry.name);
        try {
          const stat = await fsp.stat(fullPath);
          items.push({
            name: entry.name,
            isDir: entry.isDirectory(),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch {
          /* skip inaccessible */
        }
      }
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: dirPath, items });
    })
  );

  app.get(
    "/api/files/read",
    asyncHandler("Read/download file", async (req: Request, res: Response) => {
      const filePath = safePath(req.query.path as string);
      const _bn = path.basename(filePath);
      if (_bn === ".env" || _bn === ".env.local" || _bn === ".env.production") {
        res.status(403).json({ error: "Access to .env files is denied for security" });
        return;
      }
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        res.status(400).json({ error: "Cannot download a directory" });
        return;
      }
      if (req.query.format === "text") {
        const content = await fsp.readFile(filePath, "utf8");
        res.json({
          path: filePath,
          content,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
        return;
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", 'attachment; filename="' + path.basename(filePath) + '"');
      res.setHeader("Content-Length", stat.size);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    })
  );

  app.post(
    "/api/files/upload",
    asyncHandler("Upload file", async (req: Request, res: Response) => {
      const Busboy = require("busboy");
      const uploadPath = req.headers["x-upload-path"] as string;
      if (!uploadPath) {
        res.status(400).json({ error: "X-Upload-Path header required" });
        return;
      }
      const destDir = safeWritePath(uploadPath);
      await fsp.mkdir(destDir, { recursive: true });

      const bb = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_UPLOAD },
      });
      const uploaded: Promise<string>[] = [];

      bb.on("file", (fieldname: string, file: any, info: any) => {
        const filename = info.filename || fieldname;
        const dest = path.join(destDir, path.basename(filename));
        // Verify dest is safe
        try {
          safePath(dest);
        } catch {
          file.resume();
          return;
        }
        const ws = fs.createWriteStream(dest);
        file.pipe(ws);
        uploaded.push(
          new Promise<string>((resolve, reject) => {
            ws.on("finish", () => resolve(filename));
            ws.on("error", reject);
            file.on("limit", () => {
              ws.destroy();
              reject(new Error("File too large"));
            });
          })
        );
      });

      bb.on("finish", async () => {
        try {
          const names = await Promise.all(uploaded);
          storage
            .logActivity({
              action: "file_uploaded",
              details: "Uploaded " + names.length + " file(s) to " + uploadPath + ": " + names.join(", "),
            })
            .catch(() => {});
          res.json({ ok: true, files: names });
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      });

      bb.on("error", (err: any) => {
        res.status(500).json({ error: err.message });
      });

      req.pipe(bb);
    })
  );

  app.post(
    "/api/files/mkdir",
    asyncHandler("Create directory", async (req: Request, res: Response) => {
      const dirPath = safeWritePath(req.body.path);
      await fsp.mkdir(dirPath, { recursive: true });
      storage
        .logActivity({ action: "file_created", details: "Created directory: " + req.body.path })
        .catch(() => {});
      res.json({ ok: true, path: dirPath });
    })
  );

  app.delete(
    "/api/files/delete",
    asyncHandler("Delete file/dir", async (req: Request, res: Response) => {
      const target = safeWritePath(req.body.path);
      if (target === FILES_ROOT) {
        res.status(400).json({ error: "Cannot delete root" });
        return;
      }
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) {
        await fsp.rm(target, { recursive: true });
      } else {
        await fsp.unlink(target);
      }
      storage
        .logActivity({
          action: "file_deleted",
          details: "Deleted " + (stat.isDirectory() ? "directory" : "file") + ": " + req.body.path,
        })
        .catch(() => {});
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/files/rename",
    asyncHandler("Rename/move", async (req: Request, res: Response) => {
      const src = safeWritePath(req.body.from);
      const dest = safeWritePath(req.body.to);
      await fsp.rename(src, dest);
      storage
        .logActivity({
          action: "file_renamed",
          details: "Renamed: " + req.body.from + " -> " + req.body.to,
        })
        .catch(() => {});
      res.json({ ok: true, from: src, to: dest });
    })
  );

  app.post(
    "/api/files/write",
    asyncHandler("Write file", async (req: Request, res: Response) => {
      const { path: fp, content } = req.body;
      if (!fp || content === undefined) {
        res.status(400).json({ error: "path and content required" });
        return;
      }
      const resolved = safeWritePath(fp);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, content, "utf8");
      storage
        .logActivity({
          action: "file_written",
          details: "Wrote: " + fp + " (" + Buffer.byteLength(content, "utf8") + " bytes)",
        })
        .catch(() => {});
      res.json({ ok: true, path: resolved, size: Buffer.byteLength(content, "utf8") });
    })
  );

  // ── VULTR VPS PROXY ROUTES ──

  app.get(
    "/api/vps/vultr/account",
    asyncHandler("Vultr account info", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const data = await vultrFetch(key, "/account");
      res.json(data);
    })
  );

  app.get(
    "/api/vps/vultr/instances",
    asyncHandler("List Vultr instances", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const data = await vultrFetch(key, "/instances?per_page=100");
      res.json(data);
    })
  );

  app.get(
    "/api/vps/vultr/instances/:id",
    asyncHandler("Get Vultr instance", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const data = await vultrFetch(key, "/instances/" + req.params.id);
      res.json(data);
    })
  );

  app.post(
    "/api/vps/vultr/instances",
    asyncHandler("Create Vultr instance", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const { region, plan, os_id, label, sshkey_id, hostname, backups, enable_ipv6, tags } =
        req.body;
      const body: any = {
        region,
        plan,
        os_id: Number(os_id),
        label: label || "spawn-vps",
      };
      if (sshkey_id) body.sshkey_id = Array.isArray(sshkey_id) ? sshkey_id : [sshkey_id];
      if (hostname) body.hostname = hostname;
      if (backups) body.backups = backups;
      if (enable_ipv6) body.enable_ipv6 = enable_ipv6;
      if (tags) body.tags = tags;
      const data = await vultrFetch(key, "/instances", { method: "POST", body });
      await storage.logActivity({
        action: "vultr_instance_created",
        details: "Created Vultr instance: " + (label || body.region + "/" + body.plan),
      });
      res.status(201).json(data);
    })
  );

  app.delete(
    "/api/vps/vultr/instances/:id",
    asyncHandler("Destroy Vultr instance", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      await vultrFetch(key, "/instances/" + req.params.id, { method: "DELETE" });
      await storage.logActivity({
        action: "vultr_instance_destroyed",
        details: "Destroyed Vultr instance: " + req.params.id,
      });
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/vps/vultr/instances/:id/:action",
    asyncHandler("Vultr instance action", async (req: Request, res: Response) => {
      const validActions = ["start", "halt", "reboot", "reinstall"];
      const action = req.params.action as string;
      if (!validActions.includes(action)) {
        res.status(400).json({ error: "Invalid action. Allowed: " + validActions.join(", ") });
        return;
      }
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      await vultrFetch(key, "/instances/" + req.params.id + "/" + action, { method: "POST" });
      await storage.logActivity({
        action: "vultr_instance_" + action,
        details: action + " Vultr instance: " + req.params.id,
      });
      res.json({ ok: true, action });
    })
  );

  app.get(
    "/api/vps/vultr/regions",
    asyncHandler("List Vultr regions", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const now = Date.now();
      if (vultrCache.regions && now - vultrCache.regionsAt < VULTR_CACHE_TTL) {
        res.json(vultrCache.regions);
        return;
      }
      const data = await vultrFetch(key, "/regions?per_page=500");
      vultrCache.regions = data;
      vultrCache.regionsAt = now;
      res.json(data);
    })
  );

  app.get(
    "/api/vps/vultr/plans",
    asyncHandler("List Vultr plans", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const now = Date.now();
      if (vultrCache.plans && now - vultrCache.plansAt < VULTR_CACHE_TTL) {
        res.json(vultrCache.plans);
        return;
      }
      const data = await vultrFetch(key, "/plans?per_page=500&type=all");
      vultrCache.plans = data;
      vultrCache.plansAt = now;
      res.json(data);
    })
  );

  app.get(
    "/api/vps/vultr/os",
    asyncHandler("List Vultr OS images", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const now = Date.now();
      if (vultrCache.os && now - vultrCache.osAt < VULTR_CACHE_TTL) {
        res.json(vultrCache.os);
        return;
      }
      const data = await vultrFetch(key, "/os?per_page=500");
      vultrCache.os = data;
      vultrCache.osAt = now;
      res.json(data);
    })
  );

  app.get(
    "/api/vps/vultr/ssh-keys",
    asyncHandler("List Vultr SSH keys", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const data = await vultrFetch(key, "/ssh-keys");
      res.json(data);
    })
  );

  app.post(
    "/api/vps/vultr/ssh-keys",
    asyncHandler("Create Vultr SSH key", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const { name, ssh_key } = req.body;
      if (!name || !ssh_key) {
        res.status(400).json({ error: "name and ssh_key required" });
        return;
      }
      const data = await vultrFetch(key, "/ssh-keys", {
        method: "POST",
        body: { name, ssh_key },
      });
      await storage.logActivity({
        action: "vultr_ssh_key_created",
        details: "Added SSH key to Vultr: " + name,
      });
      res.status(201).json(data);
    })
  );

  app.post(
    "/api/vps/vultr/ssh-keys/upload-local",
    asyncHandler("Upload local SSH key to Vultr", async (req: Request, res: Response) => {
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const homeDir = process.env.HOME || "/home/codeman";
      const sshDir = path.join(homeDir, ".ssh");
      let pubKeyContent: string | null = null;
      let pubKeyFile = "";
      for (const f of ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"]) {
        const p = path.join(sshDir, f);
        if (fs.existsSync(p)) {
          pubKeyContent = fs.readFileSync(p, "utf-8").trim();
          pubKeyFile = f;
          break;
        }
      }
      if (!pubKeyContent) {
        res.status(404).json({ error: "No public key found in ~/.ssh/" });
        return;
      }
      const hostName = os.hostname();
      const keyName = "spawn-" + hostName + "-" + pubKeyFile.replace(".pub", "");
      const data = await vultrFetch(key, "/ssh-keys", {
        method: "POST",
        body: { name: keyName, ssh_key: pubKeyContent },
      });
      await storage.logActivity({
        action: "vultr_ssh_key_uploaded",
        details: "Uploaded " + pubKeyFile + " to Vultr as " + keyName,
      });
      res.status(201).json({ ...data, keyName, keyFile: pubKeyFile });
    })
  );

  app.post(
    "/api/vps/vultr/deploy",
    asyncHandler("Deploy to Vultr instance", async (req: Request, res: Response) => {
      const { instanceId, projectName, sshUser, remotePath, postDeployCmd } = req.body;
      if (!instanceId || !projectName) {
        res.status(400).json({ error: "instanceId and projectName required" });
        return;
      }
      const key = await resolveVultrKey(req.query.conn as string | undefined);
      const instData = await vultrFetch(key, "/instances/" + instanceId);
      const ip = instData.instance?.main_ip;
      if (!ip) {
        res.status(400).json({ error: "Could not determine instance IP" });
        return;
      }
      const user = sshUser || "root";
      const rPath = remotePath || "/var/www/" + projectName;
      const projectDir = "/var/www/scws/projects/" + projectName;
      if (!fs.existsSync(projectDir)) {
        res.status(404).json({ error: "Project not found: " + projectName });
        return;
      }

      const steps: string[] = [];
      try {
        // Ensure remote directory exists
        await execFileAsync(
          "ssh",
          [
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=10",
            user + "@" + ip,
            "mkdir -p " + rPath,
          ],
          { timeout: 15000 }
        );
        steps.push("mkdir: ok");

        // SCP the project
        await execFileAsync(
          "scp",
          [
            "-o", "StrictHostKeyChecking=accept-new",
            "-r",
            projectDir + "/.",
            user + "@" + ip + ":" + rPath + "/",
          ],
          { timeout: 120000 }
        );
        steps.push("scp: ok");

        // Post-deploy command
        if (postDeployCmd) {
          const allowedCmdPattern = /^[a-zA-Z0-9_.\/\- ]+$/;
          if (!allowedCmdPattern.test(postDeployCmd)) {
            res.status(400).json({ error: "postDeployCmd contains disallowed characters" });
            return;
          }
          const allowedPrefixes = [
            "npm install",
            "npm run",
            "npm ci",
            "pm2 restart",
            "pm2 start",
            "pm2 stop",
            "systemctl restart",
            "bash deploy.sh",
            "node ",
            "npx ",
          ];
          const cmdAllowed = allowedPrefixes.some((p) => postDeployCmd.startsWith(p));
          if (!cmdAllowed) {
            res.status(400).json({
              error:
                "postDeployCmd must start with an allowed command prefix (npm, pm2, node, npx, systemctl restart, bash deploy.sh)",
            });
            return;
          }
          const { stdout: cmdOut } = await execFileAsync(
            "ssh",
            [
              "-o", "StrictHostKeyChecking=accept-new",
              user + "@" + ip,
              "cd " + rPath + " && " + postDeployCmd,
            ],
            { timeout: 60000 }
          );
          steps.push("post-deploy: " + (cmdOut || "ok").trim().slice(0, 200));
        }

        await storage.logActivity({
          action: "vultr_deploy",
          details: "Deployed " + projectName + " to " + ip + ":" + rPath,
        });
        res.json({ ok: true, ip, remotePath: rPath, steps });
      } catch (err: any) {
        res.status(500).json({ error: "Deploy failed: " + err.message, steps });
      }
    })
  );

  log("Vultr VPS proxy routes loaded", "startup");
  log("Connections & Files API routes loaded", "startup");
}
