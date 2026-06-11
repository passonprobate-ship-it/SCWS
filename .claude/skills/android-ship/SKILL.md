---
name: android-ship
description: Build an Android project APK and install it on a device over wireless ADB — daemon API build, connect/pair handling, install, launch verify. Use for "build and deploy <app> to my phone", "ship the APK", "install on the S23".
---

# Android Ship — build APK → install on device

Reference: `/var/www/scws/docs/ANDROID-DEVELOPMENT.md` for SDK/ARM64 details. Default test device: Samsung S23+ (SM-S916B) at Tailscale IP `100.77.196.126`, wireless ADB.

All daemon calls need the token:

```bash
TOKEN=$(grep -oP '^DASHBOARD_TOKEN=\K.*' /var/www/scws/daemon/.env | tr -d '[:space:]')
```

## 1. Device online?

```bash
curl -s http://localhost:4000/api/android/devices -H 'Authorization: Bearer '"$TOKEN"''
```

If the device is listed with status `device`, skip to step 2. If not:

- **Reconnect** (already paired): `POST /api/android/devices/connect` with `{"ip":"100.77.196.126","port":"<port>"}`. The wireless-debugging port is **random and changes** when the phone reboots or toggles WiFi — the user must read it from Settings → Developer options → Wireless debugging. Don't guess; ask for the current port.
- **First-time pairing** (new device, or phone says "unpaired"): user taps "Pair device with pairing code" — that screen shows a *different* port + 6-digit code. `POST /api/android/devices/pair` with `{"ip":"...","port":"<pairing-port>","code":"123456"}`, then connect using the main wireless-debugging port.
- `offline` in the device list: `POST /api/android/devices/disconnect` with `{"serial":"<ip:port>"}`, then reconnect.

## 2. Build

```bash
curl -s -X POST "http://localhost:4000/api/projects/<name>/build-android" \
  -H 'Authorization: Bearer '"$TOKEN"'' -H "Content-Type: application/json" \
  -d '{"buildType":"debug"}' --max-time 660
```

`buildType`: `debug` (default) or `release`. Returns `{ok, duration, apkPath, apkSize}`. Daemon timeout is 10 min; simple builds run ~2 min, Compose+Hilt+KSP longer. On failure the response `error` field has the last 2000 chars of gradle output — diagnose from there.

Fallback (daemon down, or you want full gradle output):

```bash
cd /var/www/scws/projects/<name> && JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64 ./gradlew assembleDebug --no-daemon
```

ARM64 gotcha: `gradle.properties` must contain `android.aapt2FromMavenOverride=/usr/bin/aapt2` (Google ships x86_64 binaries). Gradle heap via `org.gradle.jvmargs`: 512 MB simple, 1024 MB for Compose+Hilt+KSP.

## 3. Install

```bash
curl -s -X POST "http://localhost:4000/api/projects/<name>/install-android" \
  -H 'Authorization: Bearer '"$TOKEN"'' -H "Content-Type: application/json" \
  -d '{"serial":"100.77.196.126:<port>"}'
```

Auto-finds the newest APK (debug, then release) if `apkPath` is omitted; pass `apkPath` explicitly when shipping a release build that has a debug sibling. `{"ok":true}` means `adb install -r` reported Success.

## 4. Launch + verify

```bash
adb -s <serial> shell monkey -p <package> -c android.intent.category.LAUNCHER 1
adb -s <serial> shell pidof <package>     # non-empty = running
```

Package name comes from the project's CLAUDE.md (e.g. `com.rovo`, `com.xpat`, `com.keystone`). For crash triage: `adb -s <serial> logcat -d --pid=$(adb -s <serial> shell pidof <package>) | tail -50`.

## Notes

- Android projects have **no server, no port, no nginx** — never try to spool them; build/install is their whole lifecycle.
- Build history: `GET /api/android/builds` (last 50 from activity_log).
- Release builds need signing config in the project; unsigned release APKs won't install — use debug for device testing unless the user asks for release.
