import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import type { Application } from "express";
import { asyncHandler } from "./asyncHandler.js";
import { storage } from "./storage.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const ANDROID_HOME = process.env.ANDROID_HOME || "/opt/android-sdk";
const PROJECTS_DIR = "/var/www/scws/projects";

// ── Helpers ──────────────────────────────────────────────────────────

async function run(cmd: string, args: string[], opts: Record<string, any> = {}): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: opts.timeout || 10_000,
      env: { ...process.env, ANDROID_HOME },
      ...opts,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function runWithStderr(cmd: string, args: string[], opts: Record<string, any> = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: opts.timeout || 10_000,
    env: { ...process.env, ANDROID_HOME },
    ...opts,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ── Route registration ───────────────────────────────────────────────

export function registerAndroidRoutes(app: Application): void {

  // GET /api/android/status — detect JDK, SDK, ADB, build-tools versions
  app.get("/api/android/status", asyncHandler("Android status", async (_req, res) => {
    const [javaOut, adbOut, sdkOut] = await Promise.allSettled([
      run("java", ["-version"]).then(() => null).catch(() => null),
      run("adb", ["version"]),
      run(path.join(ANDROID_HOME, "cmdline-tools/latest/bin/sdkmanager"), ["--version"]),
    ]);

    // java -version outputs to stderr
    let javaVersion: string | null = null;
    try {
      const { stderr } = await execFileAsync("java", ["-version"], { timeout: 5_000 });
      const m = stderr.match(/version "([^"]+)"/);
      if (m) javaVersion = m[1];
    } catch (e: any) {
      const m = e?.stderr?.match?.(/version "([^"]+)"/);
      if (m) javaVersion = m[1];
    }

    let adbVersion: string | null = null;
    if (adbOut.status === "fulfilled" && adbOut.value) {
      const m = adbOut.value.match(/Android Debug Bridge version ([\d.]+)/);
      if (m) adbVersion = m[1];
    }

    const sdkVersion = sdkOut.status === "fulfilled" ? sdkOut.value : null;

    // Check installed build-tools
    const buildToolsDir = path.join(ANDROID_HOME, "build-tools");
    let buildTools: string[] = [];
    if (dirExists(buildToolsDir)) {
      try {
        buildTools = (await fs.promises.readdir(buildToolsDir)).filter(
          d => dirExists(path.join(buildToolsDir, d))
        );
      } catch { /* ignore */ }
    }

    // Check installed platforms
    const platformsDir = path.join(ANDROID_HOME, "platforms");
    let platforms: string[] = [];
    if (dirExists(platformsDir)) {
      try {
        platforms = (await fs.promises.readdir(platformsDir)).filter(
          d => dirExists(path.join(platformsDir, d))
        );
      } catch { /* ignore */ }
    }

    const hasPlatformTools = fileExists(path.join(ANDROID_HOME, "platform-tools/adb")) ||
      adbVersion !== null;

    res.json({
      sdkPath: ANDROID_HOME,
      sdkInstalled: dirExists(ANDROID_HOME) && (buildTools.length > 0 || platforms.length > 0),
      java: { installed: javaVersion !== null, version: javaVersion },
      adb: { installed: adbVersion !== null, version: adbVersion },
      sdkManager: { installed: sdkVersion !== null, version: sdkVersion },
      buildTools,
      platforms,
      platformTools: hasPlatformTools,
    });
  }));

  // GET /api/android/devices — parse adb devices output
  app.get("/api/android/devices", asyncHandler("Android devices", async (_req, res) => {
    const out = await run("adb", ["devices", "-l"]);
    if (!out) { res.json({ devices: [] }); return; }

    const devices: Array<{ serial: string; state: string; model?: string; product?: string; transport?: string }> = [];
    const lines = out.split("\n").slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const serial = parts[0];
      const state = parts[1];
      const info: Record<string, string> = {};
      for (let i = 2; i < parts.length; i++) {
        const kv = parts[i].split(":");
        if (kv.length === 2) info[kv[0]] = kv[1];
      }
      devices.push({
        serial,
        state,
        model: info.model,
        product: info.product,
        transport: info.transport_id ? `transport_id:${info.transport_id}` : undefined,
      });
    }

    res.json({ devices });
  }));

  // POST /api/android/devices/connect — adb connect ip:port
  app.post("/api/android/devices/connect", asyncHandler("ADB connect", async (req, res) => {
    const { ip, port } = req.body || {};
    if (!ip || typeof ip !== "string") { res.status(400).json({ error: "ip required" }); return; }
    if (!/^[\d.:a-fA-F]+$/.test(ip)) { res.status(400).json({ error: "invalid ip format" }); return; }
    const target = port ? `${ip}:${port}` : `${ip}:5555`;

    try {
      const { stdout, stderr } = await runWithStderr("adb", ["connect", target], { timeout: 15_000 });
      const output = stdout || stderr;
      const connected = output.includes("connected");
      await storage.logActivity({ action: "adb_connect", details: `adb connect ${target}: ${output}` });
      res.json({ ok: connected, output });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  // POST /api/android/devices/disconnect — adb disconnect serial
  app.post("/api/android/devices/disconnect", asyncHandler("ADB disconnect", async (req, res) => {
    const { serial } = req.body || {};
    if (!serial || typeof serial !== "string") { res.status(400).json({ error: "serial required" }); return; }
    if (!/^[\d.:a-zA-Z_-]+$/.test(serial)) { res.status(400).json({ error: "invalid serial format" }); return; }

    try {
      const { stdout } = await runWithStderr("adb", ["disconnect", serial], { timeout: 10_000 });
      await storage.logActivity({ action: "adb_disconnect", details: `adb disconnect ${serial}: ${stdout}` });
      res.json({ ok: true, output: stdout });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  // GET /api/android/builds — recent android builds from activity_log
  app.get("/api/android/builds", asyncHandler("Android builds", async (_req, res) => {
    const activities = await storage.getActivities(50);
    const builds = activities.filter(a => a.action === "android_build");
    res.json({ builds });
  }));

  // POST /api/projects/:name/build-android — run gradle build
  app.post("/api/projects/:name/build-android", asyncHandler("Android build", async (req, res) => {
    const { name } = req.params;
    const { buildType } = req.body || {};
    const type = buildType === "release" ? "Release" : "Debug";

    // Validate project name
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { res.status(400).json({ error: "invalid project name" }); return; }

    const projectDir = path.join(PROJECTS_DIR, name);
    if (!dirExists(projectDir)) { res.status(404).json({ error: `project ${name} not found` }); return; }

    const gradlew = path.join(projectDir, "gradlew");
    if (!fileExists(gradlew)) { res.status(400).json({ error: "no gradlew found in project" }); return; }

    const task = `assemble${type}`;
    const startTime = Date.now();

    try {
      // Ensure gradlew is executable
      await fs.promises.chmod(gradlew, 0o755);

      const { stdout, stderr } = await runWithStderr(gradlew, [task, "--no-daemon"], {
        cwd: projectDir,
        timeout: 600_000,
        env: {
          ...process.env,
          ANDROID_HOME,
          GRADLE_OPTS: "-Xmx512m",
          JAVA_HOME: "/usr/lib/jvm/java-17-openjdk-arm64",
        },
      });

      const duration = Date.now() - startTime;

      // Find APK
      let apkPath: string | null = null;
      let apkSize: number | null = null;
      const apkDir = path.join(projectDir, "app/build/outputs/apk", type.toLowerCase());
      if (dirExists(apkDir)) {
        try {
          const files = await fs.promises.readdir(apkDir);
          const apk = files.find(f => f.endsWith(".apk"));
          if (apk) {
            apkPath = path.join(apkDir, apk);
            const st = await fs.promises.stat(apkPath);
            apkSize = st.size;
          }
        } catch { /* ignore */ }
      }

      await storage.logActivity({
        action: "android_build",
        projectId: null,
        details: JSON.stringify({ project: name, type, success: true, duration, apkPath, apkSize }),
      });
      log(`Android build ${name} (${type}) succeeded in ${Math.round(duration / 1000)}s`, "system");

      res.json({ ok: true, type, duration, apkPath, apkSize, output: stdout.slice(-2000) });
    } catch (e: any) {
      const duration = Date.now() - startTime;
      const errMsg = e.stderr || e.message || String(e);
      await storage.logActivity({
        action: "android_build",
        projectId: null,
        details: JSON.stringify({ project: name, type, success: false, duration, error: errMsg.slice(0, 500) }),
      });
      log(`Android build ${name} (${type}) failed: ${errMsg.slice(0, 200)}`, "error");
      res.status(500).json({ ok: false, type, duration, error: errMsg.slice(-2000) });
    }
  }));

  // POST /api/projects/:name/install-android — adb install APK
  app.post("/api/projects/:name/install-android", asyncHandler("Android install", async (req, res) => {
    const { name } = req.params;
    const { serial, apkPath } = req.body || {};

    if (!serial || typeof serial !== "string") { res.status(400).json({ error: "serial required" }); return; }
    if (!/^[\d.:a-zA-Z_-]+$/.test(serial)) { res.status(400).json({ error: "invalid serial format" }); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { res.status(400).json({ error: "invalid project name" }); return; }

    const projectDir = path.join(PROJECTS_DIR, name);
    if (!dirExists(projectDir)) { res.status(404).json({ error: `project ${name} not found` }); return; }

    // Find APK — use provided path or search for debug APK
    let resolvedApk = apkPath;
    if (!resolvedApk) {
      const debugDir = path.join(projectDir, "app/build/outputs/apk/debug");
      const releaseDir = path.join(projectDir, "app/build/outputs/apk/release");
      for (const dir of [debugDir, releaseDir]) {
        if (dirExists(dir)) {
          try {
            const files = await fs.promises.readdir(dir);
            const apk = files.find(f => f.endsWith(".apk"));
            if (apk) { resolvedApk = path.join(dir, apk); break; }
          } catch { /* ignore */ }
        }
      }
    }

    if (!resolvedApk) { res.status(404).json({ error: "no APK found — build first" }); return; }

    // Validate path is within project dir
    const realPath = await fs.promises.realpath(resolvedApk).catch(() => null);
    if (!realPath || !realPath.startsWith(PROJECTS_DIR)) {
      res.status(400).json({ error: "APK path must be within projects directory" }); return;
    }

    try {
      const { stdout, stderr } = await runWithStderr("adb", ["-s", serial, "install", "-r", resolvedApk], {
        timeout: 120_000,
      });
      const output = stdout || stderr;
      const success = output.includes("Success");
      await storage.logActivity({
        action: "android_install",
        details: `adb install on ${serial}: ${name} — ${success ? "Success" : output.slice(0, 200)}`,
      });
      res.json({ ok: success, output });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }));

  // GET /api/android/settings — read from daemon_config
  app.get("/api/android/settings", asyncHandler("Android settings", async (_req, res) => {
    const keys = [
      "android-sdk-path",
      "android-default-target-sdk",
      "android-default-min-sdk",
      "android-keystore-path",
      "android-adb-port",
    ];
    const settings: Record<string, string | undefined> = {};
    for (const k of keys) {
      settings[k] = await storage.getConfig(k);
    }
    // Default SDK path if not set
    if (!settings["android-sdk-path"]) settings["android-sdk-path"] = ANDROID_HOME;
    res.json(settings);
  }));

  // PATCH /api/android/settings — write to daemon_config
  app.patch("/api/android/settings", asyncHandler("Update Android settings", async (req, res) => {
    const allowed = [
      "android-sdk-path",
      "android-default-target-sdk",
      "android-default-min-sdk",
      "android-keystore-path",
      "android-adb-port",
    ];
    const body = req.body || {};
    const updated: string[] = [];
    for (const key of allowed) {
      if (key in body) {
        const val = String(body[key] || "").slice(0, 500);
        await storage.setConfig(key, val);
        updated.push(key);
      }
    }
    res.json({ ok: true, updated });
  }));

  log("Android module routes registered", "startup");
}
