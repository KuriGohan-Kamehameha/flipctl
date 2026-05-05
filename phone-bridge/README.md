# Flipctl Bridge

Phone-side Capacitor app (Android-only for now). Hosts a foreground service
that runs `NanoHTTPD` on `127.0.0.1:8765`. The Hub app (running inside the
Even App webview on the same phone) POSTs commands here; in Phase 2 the
service will dispatch over BLE to the Flipper Zero.

```
┌──────────────────────────────────┐
│  Even App (foreground)           │
│   └── Hub app webview ───┐       │
└──────────────────────────┼───────┘
                           │ HTTP localhost:8765
                           ▼
┌──────────────────────────────────┐
│  Flipctl Bridge (background)     │
│   └── BridgeService              │
│        ├── NanoHTTPD :8765       │
│        └── (Phase 2) BLE central │
│              │                   │
└──────────────┼───────────────────┘
               │ BLE
               ▼
       ┌─────────────────┐
       │  Flipper Zero   │
       └─────────────────┘
```

## Build

Requires **JDK 17** and the Android SDK. JDK 17 is installed via Homebrew at
`/opt/homebrew/opt/openjdk@17` and as Temurin at
`/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home`. Capacitor 7
ships with `sourceCompatibility = 21` in its bundled gradle config; we
override this back to 17 in `android/build.gradle` so the build works on JDK 17.

### CLI build (verified working)

```bash
npm install
npm run build               # web shell
npx cap sync android        # copy dist/ + plugins into android/

JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home \
ANDROID_HOME=$HOME/Library/Android/sdk \
./android/gradlew -p android assembleDebug

# APK at: android/app/build/outputs/apk/debug/app-debug.apk (~4.0 MB)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

### Android Studio

```bash
npx cap open android
```

In **Settings → Build, Execution, Deployment → Build Tools → Gradle** point
the *Gradle JDK* at the Temurin 17 install, then hit **Run**. First launch
prompts for **POST_NOTIFICATIONS** and **BLUETOOTH_CONNECT** / **BLUETOOTH_SCAN**
— grant them all.

## Pair the Flipper Zero (one-time)

The bridge expects a **bonded** device whose advertised name starts with
`Flipctl-`. With the Phase-2 firmware (`../flipper-app/`) flashed:

1. On the Flipper, enable BLE advertising for the Flipctl service.
2. On the phone: **Settings → Bluetooth → Pair new device → Flipctl-XXXX**.
3. Reopen the bridge app. The foreground service auto-discovers the bonded
   device and connects.

## Verify the bridge is up

```bash
adb shell curl -s http://127.0.0.1:8765/health
# → ok

adb shell curl -s http://127.0.0.1:8765/status
# → {"link":"connected:Flipctl-A1B2","port":8765}
# Other link states: permission_missing, bt_off, no_paired_device, connecting

adb shell 'curl -s -X POST http://127.0.0.1:8765/cmd \
    -H "content-type: application/json" \
    -d "{\"kind\":\"system.lock\"}"'
# → {"ok":true,"message":"OK"}                (when Flipper is connected)
# → {"ok":false,"message":"ERR:not_connected"} (when no link)
# → {"ok":false,"message":"ERR:timeout"}       (Flipper didn't reply within 5s)
```

`/cmd` JSON shape: `{"kind":"<verb>","arg":"<optional-arg>"}`. The bridge
serializes it as `KIND[:ARG]\n` over the GATT TX characteristic and waits
up to 5s for a notify reply on the RX characteristic.

## File map

| File                                                                                  | Purpose                                                  |
|---------------------------------------------------------------------------------------|----------------------------------------------------------|
| `src/main.ts`                                                                         | Tiny status UI — polls `/health` every 2s                |
| `index.html`                                                                          | Webview shell                                            |
| `capacitor.config.ts`                                                                 | Capacitor config (app id, web dir)                       |
| `android/app/src/main/java/com/sat/flipctl/bridge/MainActivity.java`                  | Starts foreground service; requests POST_NOTIFICATIONS + BLUETOOTH_CONNECT/SCAN |
| `android/app/src/main/java/com/sat/flipctl/bridge/BridgeService.java`                 | Foreground service; owns `BridgeServer` + `FlipperLink`  |
| `android/app/src/main/java/com/sat/flipctl/bridge/BridgeServer.java`                  | NanoHTTPD; `/health`, `/status`, `/cmd` endpoints        |
| `android/app/src/main/java/com/sat/flipctl/bridge/FlipperLink.java`                   | BLE central role: bonded-device lookup, GATT TX/RX, sync `sendCommand` |
| `android/app/src/main/AndroidManifest.xml`                                            | Service decl + permissions                               |
| `android/app/build.gradle`                                                            | Adds `org.nanohttpd:nanohttpd:2.3.1`                     |

## What's still stubbed

The bridge half is done. The other end (`flipper-app/`) is not — until the
ufbt firmware app is flashed, `/cmd` will return `ERR:no_paired_device` (and
`/status` will report the same). When the firmware is in place and the user
has paired the Flipper, commands round-trip end-to-end.

If you want to bring up the bridge against a fake peer for integration
testing, the easiest path is a Python `bleak` script that advertises the
GATT service from `flipper-app/README.md` and prints whatever's written
to the TX characteristic.

## Known gotchas

- **iOS background**: not supported. iOS suspends localhost servers when the
  app backgrounds, which is exactly when Even App is foreground. iOS bringup
  needs a different design (e.g. a persistent CoreBluetooth background mode).
- **Phone reboot**: foreground service won't auto-restart on boot. Add a
  `BOOT_COMPLETED` `BroadcastReceiver` once the BLE half is reliable.
- **Battery optimization**: Android may throttle the service over time.
  Tell the user to add Flipctl Bridge to the battery-optimization exemption
  list (Settings → Apps → Flipctl Bridge → Battery → Unrestricted).
