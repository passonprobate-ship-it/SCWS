# Android Development on SPAWN

Build, deploy, and manage Android/Kotlin apps on a Raspberry Pi 5 (ARM64), with wireless ADB deployment to real devices over Tailscale.

## Overview

SPAWN can build native Android APKs using Gradle/Kotlin, then push them to connected Android devices via ADB — all from the dashboard or API. The entire Android SDK runs on ARM64 Linux with targeted workarounds for Google's x86_64-only build tools.

## Prerequisites

These are installed during SPAWN Android bootstrap (already done on this instance):

| Component | Version | Source |
|-----------|---------|--------|
| OpenJDK | 17 (headless) | `apt: openjdk-17-jdk-headless` |
| Android SDK | cmdline-tools 12.0 | Google (Java-based, arch-independent) |
| Build Tools | 34.0.0 | Google SDK + arm64 aapt/aapt2 override |
| Platform Tools | 37.0.0 | Google SDK (adb from Ubuntu repos) |
| Platforms | android-34 | Google SDK |
| ADB | 1.0.41 | `apt: android-tools-adb` (native arm64) |
| aapt2 | 2.19 | `apt: aapt` (native arm64) |

**SDK Location**: `/opt/android-sdk`
**ANDROID_HOME**: Set in `/home/codeman/.bashrc`

## ARM64 Compatibility

Google's Android SDK build-tools ship x86_64 binaries only. SPAWN uses these workarounds:

### ADB
Ubuntu's `android-tools-adb` package provides a native arm64 binary at `/usr/bin/adb`.

### AAPT2
The critical resource compiler. Ubuntu's `aapt` package provides arm64 aapt2 at `/usr/bin/aapt2`. Each Android project **must** include this in `gradle.properties`:

```properties
android.aapt2FromMavenOverride=/usr/bin/aapt2
```

Without this, AGP downloads its own x86_64 aapt2 which crashes on arm64.

### SDK Build-Tools Symlinks
```
/opt/android-sdk/build-tools/34.0.0/aapt  → /usr/lib/android-sdk/build-tools/debian/aapt
/opt/android-sdk/build-tools/34.0.0/aapt2 → /usr/lib/android-sdk/build-tools/debian/aapt2
```

### D8/Dex Compiler
Java-based (shell script wrapper + JAR) — works on any architecture.

### Zipalign
x86_64 only, no arm64 package available. Not required for debug builds. For release builds, investigate alternatives or use a CI server.

## Dashboard

The **Android** page is in the **Infrastructure** section of the dashboard sidebar.

### Sections
1. **SDK Status** — Grid showing JDK, SDK path, build-tools, platform-tools, ADB, platforms, and SDK manager versions with green/red indicators
2. **Connected Devices** — List of ADB-connected devices with Scan, Pair, and Connect buttons
3. **Build History** — Recent builds from the activity log
4. **Settings** — SDK path, default target/min SDK, keystore path, ADB port

## API Reference

All endpoints require `Authorization: Bearer <DASHBOARD_TOKEN>`.

### SDK & Status

```
GET /api/android/status
```
Returns SDK installation status, versions for all components.

### Device Management

```
GET /api/android/devices
```
Lists connected ADB devices (serial, state, model, product).

```
POST /api/android/devices/pair
Body: { "ip": "100.x.x.x", "port": "37000", "code": "123456" }
```
Pairs with a device for wireless debugging (Android 11+). The pairing port and 6-digit code come from the phone's wireless debugging screen.

```
POST /api/android/devices/connect
Body: { "ip": "100.x.x.x", "port": "44623" }
```
Connects to a paired device. Port defaults to 5555 if omitted.

```
POST /api/android/devices/disconnect
Body: { "serial": "100.77.196.126:44623" }
```

### Building

```
POST /api/projects/:name/build-android
Body: { "buildType": "debug" }  // or "release"
```
Runs `./gradlew assembleDebug` (or `assembleRelease`) in the project directory. Environment:
- `ANDROID_HOME=/opt/android-sdk`
- `GRADLE_OPTS=-Xmx512m`
- `JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64`
- Timeout: 600 seconds

Returns: `{ ok, type, duration, apkPath, apkSize, output }`

### Installing

```
POST /api/projects/:name/install-android
Body: { "serial": "100.77.196.126:44623", "apkPath": "/optional/explicit/path.apk" }
```
Installs the APK on the specified device. If `apkPath` is omitted, searches `app/build/outputs/apk/debug/` then `release/`.

### Settings

```
GET  /api/android/settings
PATCH /api/android/settings
Body: { "android-sdk-path": "...", "android-default-target-sdk": "34", ... }
```
Settings stored in `daemon_config` table with keys: `android-sdk-path`, `android-default-target-sdk`, `android-default-min-sdk`, `android-keystore-path`, `android-adb-port`.

### Build History

```
GET /api/android/builds
```
Returns recent entries from `activity_log` where `action = 'android_build'`.

## Connecting a Device (Wireless ADB)

### First Time — Pair + Connect

1. **On the phone**: Settings > Developer Options > Wireless debugging > Enable
2. Tap **Pair device with pairing code** — note the IP, pairing port, and 6-digit code
3. **On SPAWN dashboard**: Android page > **Pair** button > enter all three values
4. After "Paired successfully", click **Connect** with the main wireless debugging IP:port (shown on the wireless debugging screen, different from the pairing port)
5. Device appears in Connected Devices list

### Subsequent Connections
After pairing once, you only need to **Connect** each time (pairing persists). The port may change when wireless debugging restarts.

### Via Tailscale
If both SPAWN and the phone are on the same Tailscale network, use the phone's Tailscale IP. This works from anywhere, not just the local network.

### Via ADB Shell
```bash
# Launch an app
adb -s <serial> shell am start -n com.package.name/.MainActivity

# Take a screenshot
adb -s <serial> shell screencap /sdcard/screen.png
adb -s <serial> pull /sdcard/screen.png /tmp/screen.png

# View logs
adb -s <serial> logcat -d --pid=$(adb -s <serial> shell pidof com.package.name)
```

## Creating a New Android Project

### Project Structure
```
projects/my-app/
├── build.gradle.kts          # Root build file (AGP + Kotlin plugin versions)
├── settings.gradle.kts       # Project name, repository config
├── gradle.properties         # JVM args, aapt2 override, AndroidX
├── gradlew                   # Gradle wrapper script (must be executable)
├── gradle/wrapper/
│   ├── gradle-wrapper.jar
│   └── gradle-wrapper.properties
├── app/
│   ├── build.gradle.kts      # App module (SDK versions, dependencies)
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/your/app/MainActivity.kt
│       └── res/values/strings.xml
└── CLAUDE.md
```

### Required gradle.properties
```properties
org.gradle.jvmargs=-Xmx512m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
android.aapt2FromMavenOverride=/usr/bin/aapt2
```

### Register as Project
```bash
curl -X POST http://localhost:4000/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","displayName":"My App","framework":"android","description":"..."}'
```

Android projects show an **orange badge** on the project card.

### Build + Deploy
```bash
# Build
curl -X POST http://localhost:4000/api/projects/my-app/build-android \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"buildType":"debug"}'

# Install on connected device
curl -X POST http://localhost:4000/api/projects/my-app/install-android \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serial":"100.77.196.126:44623"}'

# Launch
adb -s 100.77.196.126:44623 shell am start -n com.your.app/.MainActivity
```

## Memory Constraints

| Resource | Limit | Notes |
|----------|-------|-------|
| Gradle JVM | 512 MB | Set via `gradle.properties` and `GRADLE_OPTS` |
| Gradle daemon | Disabled | `--no-daemon` flag to avoid persistent memory use |
| SDK footprint | ~1.5 GB | JDK + one platform + build-tools + platform-tools |
| Build cache | Grows over time | `~/.gradle/caches/` — can be cleaned with `./gradlew clean` |

## Troubleshooting

### AAPT2 Daemon startup failed
Missing `android.aapt2FromMavenOverride` in `gradle.properties`. AGP tried to use its bundled x86_64 aapt2.

### adb: cannot execute binary file
The SDK's platform-tools adb is x86_64. Use `/usr/bin/adb` (from `android-tools-adb` package).

### Build runs out of memory
Reduce Gradle heap: `org.gradle.jvmargs=-Xmx384m`. Kill background Gradle daemons: `./gradlew --stop`.

### Device shows "unauthorized"
Re-authorize on the phone. For wireless debugging, re-pair from the dashboard.

### Connection refused on adb connect
Wireless debugging may have restarted (port changed). Check the phone's wireless debugging screen for the current port.

### Slow first build
Expected — Gradle downloads dependencies and compiles everything from scratch. Subsequent builds use cache and are much faster.
