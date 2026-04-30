import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import type { Application } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runOk(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts.timeout || 10_000,
      ...opts,
    });
    return { ok: true, stdout: (stdout || "").trim(), stderr: (stderr || "").trim(), code: 0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: ((e.stdout || "") as string).trim(),
      stderr: ((e.stderr || e.message || "") as string).trim(),
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}

async function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<string | null> {
  const r = await runOk(cmd, args, opts);
  return r.ok ? r.stdout : null;
}

async function runJson(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<any | null> {
  const out = await run(cmd, args, opts);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// wpa_supplicant socket is owned by root:root mode 0770, so the daemon (running
// as `codeman`) cannot talk to it directly. Use passwordless sudo for every
// wpa_cli call. `sudo -n` ensures we never prompt — we fail fast instead.
async function wpa(args: string[], timeout = 5_000): Promise<RunResult> {
  return runOk("sudo", ["-n", "wpa_cli", "-i", "wlan0", ...args], { timeout });
}

function parseWpaStatus(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const o: Record<string, string> = {};
  raw.split("\n").forEach((l) => {
    const i = l.indexOf("=");
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  });
  return o;
}

interface ScannedNetwork {
  ssid: string;
  bssid: string;
  frequency: number;
  signal: number;
  security: string;
  flags: string;
}

function parseScanResults(raw: string | null): ScannedNetwork[] {
  if (!raw) return [];
  const lines = raw.split("\n").filter((l) => l && !l.startsWith("bssid"));
  const nets: ScannedNetwork[] = [];
  for (const l of lines) {
    const p = l.split("\t");
    if (p.length < 5) continue;
    const flags = p[3] || "";
    let security = "Open";
    if (flags.includes("WPA3") || flags.includes("SAE")) security = "WPA3";
    else if (flags.includes("WPA2")) security = "WPA2";
    else if (flags.includes("WPA")) security = "WPA";
    else if (flags.includes("WEP")) security = "WEP";
    const ssid = p[4] || "";
    if (!ssid) continue;
    nets.push({
      ssid,
      bssid: p[0],
      frequency: parseInt(p[1]) || 0,
      signal: parseInt(p[2]) || 0,
      security,
      flags,
    });
  }
  // Deduplicate by SSID, keep strongest signal
  const seen = new Map<string, ScannedNetwork>();
  for (const n of nets) {
    const existing = seen.get(n.ssid);
    if (!existing || n.signal > existing.signal) seen.set(n.ssid, n);
  }
  return Array.from(seen.values()).sort((a, b) => b.signal - a.signal);
}

// ── Helper: parse ip -j addr show output ─────────────────────────────

function parseIface(settled: PromiseSettledResult<any>) {
  const d = settled.status === "fulfilled" ? settled.value : null;
  if (!d || !d[0]) return { up: false, addresses: [] as string[], mac: null as string | null, mtu: null as number | null };
  const i = d[0];
  const addrs = (i.addr_info || [])
    .filter((a: any) => a.family === "inet")
    .map((a: any) => a.local as string);
  return {
    up: i.operstate === "UP",
    addresses: addrs,
    mac: (i.address as string) || null,
    mtu: (i.mtu as number) || null,
  };
}

// ── Netplan YAML editor (structured, preserves other networks) ───────
//
// Netplan-generated YAML for wifi follows this exact shape:
//
//   network:
//     wifis:
//       wlan0:
//         optional: true
//         dhcp4: true
//         access-points:
//           "Home":
//             auth:
//               key-management: "psk"
//               password: "<hex>"
//           "Office":
//             auth:
//               key-management: "psk"
//               password: "<hex>"
//
// We parse the access-points section line-by-line (indent-aware), upsert/remove
// a single SSID, and re-render only that block — leaving regulatory-domain,
// dhcp4, eth0, etc. completely untouched.

interface KnownNet { ssid: string; pskHex: string; keyMgmt: string; }

const NETPLAN_PATH = "/etc/netplan/50-cloud-init.yaml";
const AP_HEAD_RE = /^      access-points:\s*(\{\s*\})?\s*$/;
const SSID_LINE_RE = /^ {8}"([^"]+)":\s*$/;
const PASSWORD_RE = /^ {12}password:\s*"([0-9a-fA-F]+)"\s*$/;
const KEYMGMT_RE = /^ {12}key-management:\s*"([^"]+)"\s*$/;

function parseAccessPoints(yaml: string): KnownNet[] {
  const lines = yaml.split("\n");
  const out: KnownNet[] = [];
  let inAp = false;
  let cur: Partial<KnownNet> | null = null;

  for (const line of lines) {
    if (AP_HEAD_RE.test(line)) { inAp = true; continue; }
    if (!inAp) continue;
    // End of access-points block: a non-empty line that does NOT start with 8+ spaces
    if (line.length > 0 && !line.startsWith("        ")) {
      if (cur && cur.ssid && cur.pskHex) out.push(cur as KnownNet);
      cur = null;
      inAp = false;
      continue;
    }
    const sm = line.match(SSID_LINE_RE);
    if (sm) {
      if (cur && cur.ssid && cur.pskHex) out.push(cur as KnownNet);
      cur = { ssid: sm[1], keyMgmt: "psk", pskHex: "" };
      continue;
    }
    const pm = line.match(PASSWORD_RE);
    if (pm && cur) { cur.pskHex = pm[1]; continue; }
    const km = line.match(KEYMGMT_RE);
    if (km && cur) { cur.keyMgmt = km[1]; continue; }
  }
  if (cur && cur.ssid && cur.pskHex) out.push(cur as KnownNet);
  return out;
}

function renderAccessPoints(nets: KnownNet[]): string {
  if (!nets.length) return "      access-points: {}";
  const blocks = nets.map(
    (n) =>
      `        "${n.ssid}":\n          auth:\n            key-management: "${n.keyMgmt}"\n            password: "${n.pskHex}"`,
  );
  return "      access-points:\n" + blocks.join("\n");
}

// Remove the entire `  wifis:` block (and its children). netplan rejects
// access-points: {} so we cut wifi management out completely when there are
// no known networks left. ensureWifisBlock() puts it back when the user
// connects to a new SSID.
function removeWifisBlock(yaml: string): string {
  const lines = yaml.split("\n");
  const startIdx = lines.findIndex((l) => /^  wifis:\s*$/.test(l));
  if (startIdx < 0) return yaml;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    // wifis content is indented ≥4 spaces; first non-empty line at indent <4 ends the block
    if (ln.length > 0 && !/^    /.test(ln)) { endIdx = i; break; }
  }
  return [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join("\n");
}

// Ensure a minimal wifis:wlan0 block exists in the YAML so replaceAccessPoints
// has something to attach to. No regulatory-domain (let kernel follow AP beacon).
function ensureWifisBlock(yaml: string): string {
  if (/^  wifis:\s*$/m.test(yaml)) return yaml;
  const lines = yaml.split("\n");
  // Insert at end of network: structure (last line at indent ≥2)
  let insertIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length === 0) continue;
    if (lines[i].startsWith("  ")) { insertIdx = i + 1; break; }
  }
  const block = [
    "  wifis:",
    "    wlan0:",
    "      optional: true",
    "      dhcp4: true",
  ];
  return [...lines.slice(0, insertIdx), ...block, ...lines.slice(insertIdx)].join("\n");
}

function replaceAccessPoints(yaml: string, nets: KnownNet[]): string {
  if (nets.length === 0) return removeWifisBlock(yaml);
  yaml = ensureWifisBlock(yaml);
  const lines = yaml.split("\n");
  const startIdx = lines.findIndex((l) => AP_HEAD_RE.test(l));
  if (startIdx < 0) {
    // No access-points block exists; insert one at end of wlan0:
    const wlanIdx = lines.findIndex((l) => /^    wlan0:\s*$/.test(l));
    if (wlanIdx < 0) throw new Error("netplan has no wlan0 block (cannot configure WiFi)");
    // Find end of wlan0 block: next line at indent ≤4 spaces and non-empty
    let endIdx = lines.length;
    for (let i = wlanIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.length > 0 && !ln.startsWith("      ")) { endIdx = i; break; }
    }
    const rendered = renderAccessPoints(nets).split("\n");
    return [...lines.slice(0, endIdx), ...rendered, ...lines.slice(endIdx)].join("\n");
  }
  // Find where access-points block ends: first non-empty line not indented ≥8 spaces
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.length > 0 && !ln.startsWith("        ")) { endIdx = i; break; }
  }
  const rendered = renderAccessPoints(nets).split("\n");
  return [...lines.slice(0, startIdx), ...rendered, ...lines.slice(endIdx)].join("\n");
}

async function readNetplan(): Promise<string> {
  const r = await runOk("sudo", ["-n", "cat", NETPLAN_PATH], { timeout: 5_000 });
  if (!r.ok) throw new Error("Could not read netplan: " + (r.stderr || "unknown error"));
  return r.stdout;
}

async function writeNetplan(content: string): Promise<void> {
  // Backup first
  await execFileAsync("sudo", ["-n", "cp", NETPLAN_PATH, NETPLAN_PATH + ".bak"], { timeout: 5_000 });
  // Write via tmp then mv
  const tmp = "/tmp/netplan-spawn-" + Date.now() + ".yaml";
  await fs.promises.writeFile(tmp, content, "utf8");
  await execFileAsync("sudo", ["-n", "mv", tmp, NETPLAN_PATH], { timeout: 5_000 });
  await execFileAsync("sudo", ["-n", "chmod", "600", NETPLAN_PATH], { timeout: 5_000 });
  await execFileAsync("sudo", ["-n", "chown", "root:root", NETPLAN_PATH], { timeout: 5_000 });
}

async function netplanApply(): Promise<RunResult> {
  return runOk("sudo", ["-n", "netplan", "apply"], { timeout: 30_000 });
}

// When netplan has no wifi config, no wpa_supplicant runs on wlan0 and scan
// fails. Spawn a transient supplicant with a scan-only config so the user can
// scan and connect for the first time. Killed before netplan apply so the
// netplan-spawned supplicant can take over cleanly.
const SCAN_WPA_CONF = "/tmp/spawn-wpa-scan.conf";

async function killScanWpa(): Promise<void> {
  await runOk("sudo", ["-n", "pkill", "-f", "wpa_supplicant.*spawn-wpa-scan\\.conf"], { timeout: 3_000 });
}

async function ensureWpaForScan(): Promise<void> {
  if ((await wpa(["status"], 2_000)).ok) return;
  await runOk("sudo", ["-n", "ip", "link", "set", "wlan0", "up"], { timeout: 3_000 });
  await fs.promises.writeFile(
    SCAN_WPA_CONF,
    "ctrl_interface=DIR=/run/wpa_supplicant GROUP=netdev\nupdate_config=1\n",
    "utf8",
  );
  const r = await runOk(
    "sudo",
    ["-n", "wpa_supplicant", "-B", "-i", "wlan0", "-c", SCAN_WPA_CONF, "-Dnl80211"],
    { timeout: 5_000 },
  );
  if (!r.ok) throw new Error("Could not start wpa_supplicant for scan: " + (r.stderr || "unknown"));
  for (let i = 0; i < 10; i++) {
    await new Promise((res) => setTimeout(res, 300));
    if ((await wpa(["status"], 1_000)).ok) return;
  }
  throw new Error("wpa_supplicant started but ctrl socket never came up");
}

async function restoreNetplanBackup(): Promise<void> {
  await execFileAsync("sudo", ["-n", "cp", NETPLAN_PATH + ".bak", NETPLAN_PATH], { timeout: 5_000 }).catch(() => {});
  await netplanApply();
}

// Poll wpa_state until it reaches COMPLETED (matching ssid) or timeout.
async function waitForAssociation(targetSsid: string, timeoutMs = 25_000): Promise<{ connected: boolean; status: Record<string, string> }> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, string> = {};
  while (Date.now() < deadline) {
    const r = await wpa(["status"]);
    last = parseWpaStatus(r.ok ? r.stdout : null);
    if (last.wpa_state === "COMPLETED" && last.ssid === targetSsid) {
      return { connected: true, status: last };
    }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return { connected: false, status: last };
}

// ── Route registration ───────────────────────────────────────────────

export function registerNetworkRoutes(app: Application): void {

  // GET /api/network/status — full network status overview
  app.get("/api/network/status", asyncHandler("Network status", async (_req, res) => {
    const [eth0j, wlan0j, ts, wpaR, sigR, routeJ, dnsRaw, pingRes] = await Promise.allSettled([
      runJson("ip", ["-j", "addr", "show", "eth0"]),
      runJson("ip", ["-j", "addr", "show", "wlan0"]),
      runJson("tailscale", ["status", "--json"], { timeout: 5_000 }),
      wpa(["status"]),
      wpa(["signal_poll"]),
      runJson("ip", ["-j", "route", "show", "default"]),
      run("resolvectl", ["dns"]),
      run("ping", ["-c1", "-W2", "8.8.8.8"], { timeout: 5_000 }),
    ]);

    const e0 = parseIface(eth0j);
    const w0 = parseIface(wlan0j);

    const wpaResult = wpaR.status === "fulfilled" ? wpaR.value : null;
    const sigResult = sigR.status === "fulfilled" ? sigR.value : null;
    const wpaStat = parseWpaStatus(wpaResult?.ok ? wpaResult.stdout : null);
    const sig = parseWpaStatus(sigResult?.ok ? sigResult.stdout : null);

    const tsData = ts.status === "fulfilled" ? ts.value : null;
    const tsInfo = tsData
      ? {
          up: tsData.BackendState === "Running",
          ip: (tsData.TailscaleIPs || [])[0] || null,
          hostname: tsData.Self?.DNSName?.replace(/\.$/, "") || null,
          version: tsData.Version || null,
        }
      : { up: false, ip: null, hostname: null };

    const routes = routeJ.status === "fulfilled" ? routeJ.value : null;
    const gateway =
      routes && routes[0]
        ? { ip: routes[0].gateway || null, dev: routes[0].dev || null }
        : { ip: null, dev: null };

    const dns =
      dnsRaw.status === "fulfilled" && dnsRaw.value
        ? dnsRaw.value
            .split("\n")
            .map((l: string) => {
              const m = l.match(/:\s*(.+)/);
              return m ? m[1].trim() : null;
            })
            .filter(Boolean)
        : [];

    const internet = pingRes.status === "fulfilled" && pingRes.value !== null;

    res.json({
      eth0: { ...e0 },
      wlan0: {
        ...w0,
        ssid: wpaStat.ssid || null,
        bssid: wpaStat.bssid || null,
        wpa_state: wpaStat.wpa_state || null,
        key_mgmt: wpaStat.key_mgmt || null,
        frequency: wpaStat.freq ? parseInt(wpaStat.freq) : null,
        signal: sig.RSSI ? parseInt(sig.RSSI) : null,
        linkSpeed: sig.LINKSPEED ? parseInt(sig.LINKSPEED) : null,
        noise: sig.NOISE ? parseInt(sig.NOISE) : null,
      },
      tailscale: tsInfo,
      gateway,
      dns,
      internet,
      mdns: { hostname: "spawn.local" },
    });
  }));

  // GET /api/network/wifi/scan — trigger WiFi scan, poll for results
  app.get("/api/network/wifi/scan", asyncHandler("WiFi scan", async (_req, res) => {
    try {
      await ensureWpaForScan();
    } catch (e: any) {
      log("ensureWpaForScan failed: " + e.message, "error");
      res.status(500).json({ error: "Could not initialize WiFi for scan: " + e.message });
      return;
    }
    const trig = await wpa(["scan"], 5_000);
    // wpa returns "FAIL-BUSY" if a scan is already in progress — that's fine, we just poll.
    if (!trig.ok && !/FAIL/.test(trig.stdout)) {
      log("wpa_cli scan trigger failed: " + trig.stderr, "error");
      res.status(500).json({ error: "scan trigger failed: " + (trig.stderr || trig.stdout) });
      return;
    }

    // Poll scan_results for up to 7s. Return as soon as we have stable results.
    const deadline = Date.now() + 7_000;
    let networks: ScannedNetwork[] = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      const r = await wpa(["scan_results"], 5_000);
      if (!r.ok) continue;
      const found = parseScanResults(r.stdout);
      if (found.length > 0) {
        networks = found;
        // If we already had results last poll and count is stable, break early
        if (Date.now() + 1_500 > deadline) break;
      }
    }
    res.json({ networks });
  }));

  // POST /api/network/wifi/connect — connect to a WiFi network via netplan
  // Body: { ssid, password? } — password optional if SSID is already known.
  app.post("/api/network/wifi/connect", asyncHandler("WiFi connect", async (req, res) => {
    const { ssid, password } = req.body || {};
    if (!ssid || typeof ssid !== "string")
      { res.status(400).json({ error: "ssid required" }); return; }
    if (/[\\"`${}:;\x00-\x1f\x7f]/.test(ssid) || ssid.length > 32)
      { res.status(400).json({ error: "SSID contains invalid characters or is too long" }); return; }
    if (password !== undefined) {
      if (typeof password !== "string")
        { res.status(400).json({ error: "password must be a string" }); return; }
      if (password && (password.length < 8 || password.length > 63))
        { res.status(400).json({ error: "Password must be 8-63 characters (WPA spec)" }); return; }
    }

    try {
      const currentYaml = await readNetplan();
      const known = parseAccessPoints(currentYaml);
      const isKnown = known.some((n) => n.ssid === ssid);

      let mutated = false;

      if (password) {
        // Hash password via wpa_passphrase
        const wpRes = await runOk("wpa_passphrase", [ssid, password], { timeout: 5_000 });
        if (!wpRes.ok) throw new Error("wpa_passphrase failed: " + (wpRes.stderr || "unknown"));
        const pskMatch = wpRes.stdout.match(/\tpsk=([0-9a-f]{64})/);
        if (!pskMatch) throw new Error("Could not extract PSK hash from wpa_passphrase output");
        const pskHex = pskMatch[1];

        // Upsert into known list
        const next = known.filter((n) => n.ssid !== ssid);
        next.push({ ssid, pskHex, keyMgmt: "psk" });
        const newYaml = replaceAccessPoints(currentYaml, next);
        await writeNetplan(newYaml);
        mutated = true;
      } else if (!isKnown) {
        res.status(400).json({ error: "Unknown SSID — password required for first connection" });
        return;
      }

      // Apply netplan (regenerates wpa_supplicant config + reassociates).
      // First kill any scan-only supplicant we spawned so netplan can claim wlan0.
      if (mutated) {
        await killScanWpa();
        const apply = await netplanApply();
        if (!apply.ok) {
          log("netplan apply failed, restoring backup: " + apply.stderr, "error");
          await restoreNetplanBackup();
          throw new Error("netplan apply failed: " + (apply.stderr || apply.stdout || "unknown"));
        }
      } else {
        // Already known and configured — just nudge supplicant to roam to it
        await wpa(["reassociate"]);
      }

      // Wait for association (up to 25s)
      const { connected, status } = await waitForAssociation(ssid, 25_000);

      // Get IP if connected
      let addresses: string[] = [];
      if (connected) {
        const ipJ = await runJson("ip", ["-j", "addr", "show", "wlan0"]);
        if (ipJ && ipJ[0]) {
          addresses = (ipJ[0].addr_info || [])
            .filter((a: any) => a.family === "inet")
            .map((a: any) => a.local as string);
        }
      }

      await storage.logActivity({
        action: connected ? "wifi_connect" : "wifi_connect_pending",
        details: `WiFi connect to "${ssid}": ${connected ? "success" : "pending (state=" + (status.wpa_state || "?") + ")"}`,
      });
      log(`WiFi connect to "${ssid}": ${connected ? "connected" : "pending (" + (status.wpa_state || "?") + ")"}`, "system");

      res.json({
        ok: true,
        connected,
        ssid,
        wpa_state: status.wpa_state || null,
        bssid: status.bssid || null,
        addresses,
      });
    } catch (e: any) {
      await storage.logActivity({
        action: "wifi_connect_failed",
        details: `WiFi connect to "${ssid}" failed: ${e.message}`,
      }).catch(() => {});
      log("WiFi connect failed: " + e.message, "error");
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  // GET /api/network/wifi/known — list known WiFi networks from netplan
  app.get("/api/network/wifi/known", asyncHandler("Known WiFi networks", async (_req, res) => {
    try {
      const yaml = await readNetplan();
      const known = parseAccessPoints(yaml);
      const wpaR = await wpa(["status"]);
      const st = parseWpaStatus(wpaR.ok ? wpaR.stdout : null);
      res.json({
        known: known.map((n) => n.ssid),
        current: st.ssid || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  // DELETE /api/network/wifi/known/:ssid — forget a stored network
  app.delete("/api/network/wifi/known/:ssid", asyncHandler("Forget WiFi network", async (req, res) => {
    const ssid = String(req.params.ssid || "");
    if (!ssid) { res.status(400).json({ error: "ssid required" }); return; }
    try {
      const currentYaml = await readNetplan();
      const known = parseAccessPoints(currentYaml);
      if (!known.some((n) => n.ssid === ssid)) {
        res.status(404).json({ error: "SSID not found in known networks" });
        return;
      }
      const next = known.filter((n) => n.ssid !== ssid);
      const newYaml = replaceAccessPoints(currentYaml, next);
      await writeNetplan(newYaml);

      await killScanWpa();
      const apply = await netplanApply();
      if (!apply.ok) {
        log("netplan apply failed (forget), restoring backup: " + apply.stderr, "error");
        await restoreNetplanBackup();
        throw new Error("netplan apply failed: " + (apply.stderr || apply.stdout));
      }

      await storage.logActivity({
        action: "wifi_forget",
        details: `Forgot WiFi network "${ssid}"`,
      });
      log(`Forgot WiFi network "${ssid}"`, "system");
      res.json({ ok: true, ssid, remaining: next.map((n) => n.ssid) });
    } catch (e: any) {
      await storage.logActivity({
        action: "wifi_forget_failed",
        details: `Forget WiFi "${ssid}" failed: ${e.message}`,
      }).catch(() => {});
      log("WiFi forget failed: " + e.message, "error");
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  log("Network module routes registered", "startup");
}
