import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import type { Application } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────

async function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: opts.timeout || 10_000,
      ...opts,
    });
    return stdout.trim();
  } catch {
    return null;
  }
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
    if (flags.includes("WPA3")) security = "WPA3";
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

// ── Route registration ───────────────────────────────────────────────

export function registerNetworkRoutes(app: Application): void {

  // GET /api/network/status — full network status overview
  app.get("/api/network/status", asyncHandler("Network status", async (_req, res) => {
    const [eth0j, wlan0j, ts, wpaRaw, sigRaw, routeJ, dnsRaw, pingRes] = await Promise.allSettled([
      runJson("ip", ["-j", "addr", "show", "eth0"]),
      runJson("ip", ["-j", "addr", "show", "wlan0"]),
      runJson("tailscale", ["status", "--json"], { timeout: 5_000 }),
      run("wpa_cli", ["-i", "wlan0", "status"]),
      run("wpa_cli", ["-i", "wlan0", "signal_poll"]),
      runJson("ip", ["-j", "route", "show", "default"]),
      run("resolvectl", ["dns"]),
      run("ping", ["-c1", "-W2", "8.8.8.8"], { timeout: 5_000 }),
    ]);

    const e0 = parseIface(eth0j);
    const w0 = parseIface(wlan0j);

    const wpa = parseWpaStatus(wpaRaw.status === "fulfilled" ? wpaRaw.value : null);
    const sig = parseWpaStatus(sigRaw.status === "fulfilled" ? sigRaw.value : null);

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
        ssid: wpa.ssid || null,
        bssid: wpa.bssid || null,
        wpa_state: wpa.wpa_state || null,
        key_mgmt: wpa.key_mgmt || null,
        frequency: wpa.freq ? parseInt(wpa.freq) : null,
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

  // GET /api/network/wifi/scan — trigger WiFi scan and return results
  app.get("/api/network/wifi/scan", asyncHandler("WiFi scan", async (_req, res) => {
    try {
      await run("wpa_cli", ["-i", "wlan0", "scan"], { timeout: 5_000 });
      await new Promise((r) => setTimeout(r, 3_000));
      const raw = await run("wpa_cli", ["-i", "wlan0", "scan_results"], { timeout: 5_000 });
      const networks = parseScanResults(raw);
      res.json({ networks });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  // POST /api/network/wifi/connect — connect to a WiFi network via netplan
  app.post("/api/network/wifi/connect", asyncHandler("WiFi connect", async (req, res) => {
    const { ssid, password } = req.body || {};
    if (!ssid || typeof ssid !== "string")
      { res.status(400).json({ error: "ssid required" }); return; }
    if (/[\\`${}:;\x00-\x1f\x7f]/.test(ssid) || ssid.length > 32)
      { res.status(400).json({ error: "SSID contains invalid characters or is too long" }); return; }
    if (!password || typeof password !== "string")
      { res.status(400).json({ error: "password required" }); return; }
    if (password.length < 8 || password.length > 63)
      { res.status(400).json({ error: "Password must be 8-63 characters (WPA spec)" }); return; }

    try {
      // Hash password via wpa_passphrase
      const wpOut = await run("wpa_passphrase", [ssid, password], { timeout: 5_000 });
      if (!wpOut) throw new Error("wpa_passphrase failed");
      const pskMatch = wpOut.match(/\tpsk=([0-9a-f]{64})/);
      if (!pskMatch) throw new Error("Could not extract PSK hash");
      const pskHex = pskMatch[1];

      // Read current netplan config
      const configPath = "/etc/netplan/50-cloud-init.yaml";
      const current = await run("sudo", ["cat", configPath]);
      if (!current) throw new Error("Could not read netplan config");

      // Backup
      await execFileAsync("sudo", ["cp", configPath, configPath + ".bak"], { timeout: 5_000 });

      // Build new config — replace access-points block
      const apRegex = /(access-points:\n)([\s\S]*?)(?=\n\S|\n*$)/;
      const newAp = `access-points:\n        "${ssid}":\n          auth:\n            key-management: "psk"\n            password: "${pskHex}"`;
      let newConfig: string;
      if (apRegex.test(current)) {
        newConfig = current.replace(apRegex, newAp);
      } else {
        // No access-points section — add under wlan0
        newConfig = current.replace(
          /(wlan0:\n(?:.*\n)*?)((?=\s{4}\S)|\s*$)/,
          `$1      ${newAp}\n`,
        );
      }

      // Write via temp file
      const tmpPath = "/tmp/netplan-spawn-" + Date.now() + ".yaml";
      await fs.promises.writeFile(tmpPath, newConfig, "utf8");
      await execFileAsync("sudo", ["mv", tmpPath, configPath], { timeout: 5_000 });
      await execFileAsync("sudo", ["chmod", "600", configPath], { timeout: 5_000 });
      await execFileAsync("sudo", ["chown", "root:root", configPath], { timeout: 5_000 });

      // Apply
      try {
        await execFileAsync("sudo", ["netplan", "apply"], { timeout: 30_000 });
      } catch (applyErr: any) {
        // Restore backup
        log("netplan apply failed, restoring backup: " + applyErr.message, "error");
        await execFileAsync("sudo", ["cp", configPath + ".bak", configPath], { timeout: 5_000 });
        await execFileAsync("sudo", ["netplan", "apply"], { timeout: 30_000 }).catch(() => {});
        throw new Error("netplan apply failed: " + applyErr.message);
      }

      // Wait and verify
      await new Promise((r) => setTimeout(r, 5_000));
      const statusRaw = await run("wpa_cli", ["-i", "wlan0", "status"]);
      const st = parseWpaStatus(statusRaw);
      const connected = st.wpa_state === "COMPLETED" && st.ssid === ssid;

      await storage.logActivity({
        action: "wifi_connect",
        details: `WiFi connect to "${ssid}": ${connected ? "success" : "may still be connecting"}`,
      });
      log(`WiFi connect to "${ssid}": ${connected ? "connected" : "pending"}`, "system");
      res.json({
        ok: true,
        connected,
        ssid,
        wpa_state: st.wpa_state || null,
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

  // GET /api/network/wifi/known — list known WiFi networks from netplan config
  app.get("/api/network/wifi/known", asyncHandler("Known WiFi networks", async (_req, res) => {
    try {
      const raw = await run("sudo", ["cat", "/etc/netplan/50-cloud-init.yaml"]);
      if (!raw) { res.json({ known: [], current: null }); return; }
      // Extract SSIDs from access-points section
      const ssids: string[] = [];
      const re = /"([^"]+)":\s*$/gm;
      const apSection = raw.split("access-points:")[1];
      if (apSection) {
        let m;
        while ((m = re.exec(apSection)) !== null) ssids.push(m[1]);
      }
      // Get current SSID
      const statusRaw = await run("wpa_cli", ["-i", "wlan0", "status"]);
      const st = parseWpaStatus(statusRaw);
      res.json({ known: ssids, current: st.ssid || null });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  log("Network module routes registered", "startup");
}
