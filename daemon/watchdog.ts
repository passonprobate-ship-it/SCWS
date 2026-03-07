import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { storage } from "./storage.js";
import { log } from "./logger.js";
import { pm2List } from "./pm2.js";
import { notify } from "./notifications.js";

const execFileAsync = promisify(execFile);

// ── Config ─────────────────────────────────────────────────────────

interface WatchdogConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  idleTimeoutMinutes: number;
  autoStopEnabled: boolean;
  tempThreshold: number;
  memoryThreshold: number;
  diskThreshold: number;
}

const DEFAULT_CONFIG: WatchdogConfig = {
  enabled: true,
  pollIntervalSeconds: 30,
  idleTimeoutMinutes: 30,
  autoStopEnabled: true,
  tempThreshold: 75,
  memoryThreshold: 85,
  diskThreshold: 85,
};

const CONFIG_KEY = "watchdog-config";

let pollInterval: ReturnType<typeof setInterval> | null = null;
const restartCounts = new Map<string, number>();
const crashTimes = new Map<string, number>();
const lastActivityMap = new Map<string, number>();
const healthAlertTimes = new Map<string, number>();

let _wdCache: WatchdogConfig | null = null;
let _wdCacheAt = 0;

export async function getWatchdogConfig(): Promise<WatchdogConfig> {
  if (_wdCache && Date.now() - _wdCacheAt < 60_000) return _wdCache;
  const raw = await storage.getConfig(CONFIG_KEY);
  if (!raw) {
    _wdCache = { ...DEFAULT_CONFIG };
    _wdCacheAt = Date.now();
    return _wdCache;
  }
  try {
    const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    _wdCache = parsed;
    _wdCacheAt = Date.now();
    return parsed;
  } catch {
    const fallback = { ...DEFAULT_CONFIG };
    _wdCache = fallback;
    _wdCacheAt = Date.now();
    return fallback;
  }
}

export async function updateWatchdogConfig(updates: Partial<WatchdogConfig>): Promise<WatchdogConfig> {
  _wdCache = null;
  _wdCacheAt = 0;
  const current = await getWatchdogConfig();
  const merged = { ...current, ...updates };
  await storage.setConfig(CONFIG_KEY, JSON.stringify(merged));

  if (pollInterval && (merged.pollIntervalSeconds !== current.pollIntervalSeconds || merged.enabled !== current.enabled)) {
    clearInterval(pollInterval);
    pollInterval = null;
    if (merged.enabled) {
      pollInterval = setInterval(watchdogPoll, merged.pollIntervalSeconds * 1000);
    }
  }

  return merged;
}

// ── Tracking ──────────────────────────────────────────────────────

export function watchdogTrackStart(name: string): void {
  lastActivityMap.set(name, Date.now());
}

export function watchdogTrackDelete(name: string): void {
  lastActivityMap.delete(name);
  restartCounts.delete(name);
  crashTimes.delete(name);
}

export function getWatchdogStatus(): {
  running: boolean;
  projects: Record<string, { idleMinutes: number; lastActivity: number }>;
  healthAlerts: Record<string, number>;
  crashCounts: Record<string, number>;
} {
  const now = Date.now();
  const projects: Record<string, { idleMinutes: number; lastActivity: number }> = {};
  for (const [name, ts] of lastActivityMap) {
    projects[name] = { idleMinutes: Math.round((now - ts) / 60_000), lastActivity: ts };
  }
  const healthAlerts: Record<string, number> = {};
  for (const [key, ts] of healthAlertTimes) healthAlerts[key] = ts;
  const crashCnt: Record<string, number> = {};
  for (const [name, ts] of crashTimes) crashCnt[name] = ts;
  return { running: pollInterval !== null, projects, healthAlerts, crashCounts: crashCnt };
}

// ── Lifecycle ─────────────────────────────────────────────────────

// Import stopProject lazily to avoid circular dependency
let _stopProject: ((name: string) => Promise<void>) | null = null;
async function lazyStopProject(name: string): Promise<void> {
  if (!_stopProject) {
    const mod = await import("./projects.js");
    _stopProject = mod.stopProject;
  }
  return _stopProject(name);
}

export async function startWatchdog(): Promise<void> {
  const config = await getWatchdogConfig();
  if (!config.enabled) {
    log("Watchdog disabled by config", "watchdog");
    return;
  }

  const projects = await storage.getProjects();
  const now = Date.now();
  for (const p of projects) {
    if (p.status === "running") lastActivityMap.set(p.name, now);
  }

  pollInterval = setInterval(watchdogPoll, config.pollIntervalSeconds * 1000);
  log(`Watchdog started (poll every ${config.pollIntervalSeconds}s, idle timeout ${config.idleTimeoutMinutes}min)`, "watchdog");
}

export function stopWatchdog(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log("Watchdog stopped", "watchdog");
  }
}

// ── Poll ──────────────────────────────────────────────────────────

async function watchdogPoll(): Promise<void> {
  try {
    const config = await getWatchdogConfig();
    if (!config.enabled) return;

    const pm2Raw = await pm2List();
    const pm2Procs: Array<{ name: string; pm2_env?: { status?: string; restart_time?: number; exit_code?: number }; monit?: { cpu?: number } }> = JSON.parse(pm2Raw);
    const pm2Map = new Map<string, typeof pm2Procs[0]>();
    for (const p of pm2Procs) {
      if (!p.name || p.name === "scws-daemon") continue;
      pm2Map.set(p.name.startsWith("scws-") ? p.name.replace(/^scws-/, "") : p.name, p);
    }

    const running = (await storage.getProjects()).filter(p => p.status === "running");

    for (const p of running) {
      const proc = pm2Map.get(p.name);
      await checkProjectHealth(p.name, proc);
    }

    if (config.autoStopEnabled) {
      for (const p of running) {
        const proc = pm2Map.get(p.name);
        checkIdleProject(p.name, proc, config.idleTimeoutMinutes);
      }
    }

    await checkSystemHealth(config);
  } catch (err) {
    log(`Watchdog poll error: ${err instanceof Error ? err.message : err}`, "error");
  }
}

async function checkProjectHealth(name: string, proc: { pm2_env?: { status?: string; restart_time?: number; exit_code?: number } } | undefined): Promise<void> {
  if (!proc) {
    await handleCrash(name, "Process disappeared from PM2");
    return;
  }

  const status = proc.pm2_env?.status;
  const restarts = proc.pm2_env?.restart_time ?? 0;
  const exitCode = proc.pm2_env?.exit_code ?? 0;

  if (status === "errored") {
    await handleCrash(name, `PM2 status: errored (exit code ${exitCode})`);
    return;
  }

  if (status === "stopped" && exitCode !== 0) {
    await handleCrash(name, `Stopped with exit code ${exitCode}`);
    return;
  }

  const prevRestarts = restartCounts.get(name);
  restartCounts.set(name, restarts);
  if (prevRestarts !== undefined && restarts > prevRestarts) {
    await handleCrash(name, `Crash loop detected (restarts: ${prevRestarts} \u2192 ${restarts})`);
  }
}

async function handleCrash(name: string, reason: string): Promise<void> {
  const now = Date.now();
  const lastCrash = crashTimes.get(name) ?? 0;
  if (now - lastCrash < 5 * 60_000) return; // debounce 5 min

  crashTimes.set(name, now);
  log(`Crash detected: "${name}" \u2014 ${reason}`, "watchdog");

  try {
    await storage.updateProject(name, { status: "error" });
    await storage.logActivity({ action: "crashed", details: `Watchdog: ${reason}` });
    await notify("project_crashed", `Project "${name}" crashed: ${reason}`);
  } catch (err) {
    log(`Crash handler error for "${name}": ${err instanceof Error ? err.message : err}`, "error");
  }
}

function checkIdleProject(
  name: string,
  proc: { pm2_env?: { status?: string }; monit?: { cpu?: number } } | undefined,
  idleTimeoutMinutes: number,
): void {
  if (!proc || proc.pm2_env?.status !== "online") return;

  const _noAutoStop = ["spawn-cortex"];
  if (_noAutoStop.includes(name)) {
    lastActivityMap.set(name, Date.now());
    return;
  }

  if ((proc.monit?.cpu ?? 0) > 0) {
    lastActivityMap.set(name, Date.now());
    return;
  }

  const lastActive = lastActivityMap.get(name);
  if (!lastActive) {
    lastActivityMap.set(name, Date.now());
    return;
  }

  const idleMs = Date.now() - lastActive;
  const thresholdMs = idleTimeoutMinutes * 60_000;

  if (idleMs >= thresholdMs) {
    log(`Auto-stopping idle project "${name}" (idle ${Math.round(idleMs / 60_000)}min)`, "watchdog");
    lastActivityMap.delete(name);
    lazyStopProject(name).catch(err => {
      log(`Auto-stop failed for "${name}": ${err instanceof Error ? err.message : err}`, "error");
    });
    storage.logActivity({
      action: "auto_stopped",
      details: `Watchdog: auto-stopped after ${Math.round(idleMs / 60_000)} minutes idle`,
    }).catch(() => {});
    notify("project_stopped", `Auto-stopped idle project "${name}" (idle ${Math.round(idleMs / 60_000)}min)`).catch(() => {});
  }
}

async function checkSystemHealth(config: WatchdogConfig): Promise<void> {
  const alerts: string[] = [];
  const now = Date.now();
  const alertCooldown = 15 * 60_000;

  // CPU temperature
  try {
    const tempRaw = await readFile("/sys/class/thermal/thermal_zone0/temp", "utf8");
    const temp = parseInt(tempRaw.trim()) / 1000;
    if (temp > config.tempThreshold && now - (healthAlertTimes.get("temp") ?? 0) >= alertCooldown) {
      alerts.push(`CPU temp: ${temp.toFixed(1)}\u00B0C (threshold: ${config.tempThreshold}\u00B0C)`);
      healthAlertTimes.set("temp", now);
    }
  } catch { /* no thermal zone */ }

  // Memory
  try {
    const { stdout } = await execFileAsync("free", ["-m"], { timeout: 5000 });
    const memLine = stdout.split("\n").find(l => l.startsWith("Mem:"));
    if (memLine) {
      const parts = memLine.split(/\s+/);
      const memTotal = parseInt(parts[1]) || 1;
      const memUsed = parseInt(parts[2]) || 0;
      const memPct = Math.round(memUsed / memTotal * 100);

      if (memPct > 93) {
        log(`EMERGENCY: Memory at ${memPct}% — stopping non-essential projects and dropping caches`, "watchdog");
        const allProjects = await storage.getProjects();
        for (const p of allProjects) {
          if (p.status === "running" && p.name !== "spawn-cortex") {
            try {
              await lazyStopProject(p.name);
              await storage.logActivity({ action: "emergency_stopped", details: `Memory emergency: ${memPct}% used` });
            } catch { /* ignore */ }
          }
        }
        try {
          await execFileAsync("sudo", ["sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"], { timeout: 5000 });
        } catch { /* ignore */ }
        await notify("system_health", `EMERGENCY: Memory at ${memPct}% — stopped non-essential projects`).catch(() => {});
        healthAlertTimes.set("memory", now);
      } else if (memPct > 85) {
        const idleThresh = 5 * 60_000;
        const allProjects = await storage.getProjects();
        for (const p of allProjects) {
          if (p.status === "running") {
            const lastAct = lastActivityMap.get(p.name) || 0;
            if (Date.now() - lastAct > idleThresh) {
              log(`High memory (${memPct}%) — auto-stopping idle project "${p.name}"`, "watchdog");
              try {
                await lazyStopProject(p.name);
                await storage.logActivity({ action: "memory_stopped", details: `Memory pressure: ${memPct}% — idle > 5min` });
              } catch { /* ignore */ }
            }
          }
        }
        if (now - (healthAlertTimes.get("memory") ?? 0) >= alertCooldown) {
          alerts.push(`Memory HIGH: ${memPct}% used (${memUsed}MB / ${memTotal}MB) — stopping idle projects`);
          healthAlertTimes.set("memory", now);
        }
      } else if (memPct > 70) {
        if (now - (healthAlertTimes.get("memory") ?? 0) >= alertCooldown) {
          alerts.push(`Memory WARNING: ${memPct}% used (${memUsed}MB / ${memTotal}MB, threshold: 70%)`);
          healthAlertTimes.set("memory", now);
        }
      }
    }
  } catch { /* ignore */ }

  // Disk
  try {
    const { stdout } = await execFileAsync("df", ["--output=pcent", "/"], { timeout: 5000 });
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const diskPct = parseInt(lines[1].trim().replace("%", ""));
      if (diskPct > config.diskThreshold && now - (healthAlertTimes.get("disk") ?? 0) >= alertCooldown) {
        alerts.push(`Disk: ${diskPct}% used (threshold: ${config.diskThreshold}%)`);
        healthAlertTimes.set("disk", now);
      }
    }
  } catch { /* ignore */ }

  if (alerts.length > 0) {
    const msg = alerts.join("\n");
    log(`System health alert: ${msg}`, "watchdog");
    await notify("system_health", msg).catch(() => {});
  }
}
