# Flipctl

Mirror your **Flipper Zero** on the **Even Realities G2** HUD and control it
with the **R1 ring**. One-tap launcher for any signal in your Flipper's
favourites — Sub-GHz, Infrared, NFC, RFID, iButton, FAPs.

```
Flipper Zero  ◄──BLE──►  Flipctl Bridge  ◄──HTTP──►  Hub app  ◄──webview──►  Even App  ◄──BLE──►  G2 glasses + R1 ring
                              ▲                         ▲                       ▲
                       (Capacitor +              (TypeScript,            (foreground,
                       Android foreground         inside the Even        talks to glasses
                       svc, NanoHTTPD :8765)      App webview)           + ring over BLE)
                              ──────── all on the same Android phone ────────
```

The Hub app is pure TypeScript running in the Even Hub webview. It never
touches BLE directly — all Flipper I/O is delegated to a phone-resident
companion (`Flipctl Bridge`) that owns the BLE Serial channel and exposes a
loopback-only HTTP API on `127.0.0.1:8765`.

## Layout

| Dir | What | Status |
|---|---|---|
| [`hub-app/`](hub-app)         | Even Hub TypeScript app — runs in the Even App webview          | **v1.0.0** — submitted to the Even App Store |
| [`phone-bridge/`](phone-bridge) | Capacitor + Android foreground service, NanoHTTPD on :8765, qFlipper-style BLE Serial RPC | working — mirror, favourites, app start/exit, screen stream |
| [`flipper-app/`](flipper-app)  | Flipper Zero ufbt C app (legacy)                                | **abandoned** — kept as a base for the future scan-trigger FAP |

## Features

- **Home menu launcher** — opens to a four-item home screen (Favourites,
  Mirror, Standby Mode, Settings) instead of dropping you straight into the
  mirror. Four-plus taps from any screen returns to home.
- **Live screen mirror** — Flipper's 128×64 OLED scaled to 256×128 on the
  HUD (clean 2× integer upscale, no aliasing) at 70% brightness. Position
  configurable from Settings: top-left/top-middle/top-right, centre, or
  bottom-left/bottom-middle/bottom-right.
- **Ring as remote** — the R1 ring acts as a D-pad/OK/Back for whatever
  Flipper UI is foreground.
- **Favourites picker** — every entry in `/ext/favorites.txt`, one tap to
  fire: `.sub`/`.ir` transmit on load, `.nfc`/`.rfid`/`.ibtn` enter
  emulation-armed state, `.fap` launches directly.
- **Standby Mode** — minimises the HUD to a tiny "<favourite>  READY"
  legend in a configurable corner. One tap fires; tap again to re-fire and
  dismiss the app, or double-tap to dismiss without firing again.
- **Recovery** — built-in "Exit Flipper app" item under Favourites drops
  the foreground app back to the desktop so the next launch starts cleanly.

## Why no scanner shortcuts in v1.0

NFC/RFID's RPC handlers in stock + Momentum firmware accept only
`LoadFile`/`AppExit`/`SessionClose` — no primitive triggers a card read. The
official Flipper Android app doesn't summon scans either; it only emulates
already-saved cards. Reliable scanner shortcuts need either a custom
on-Flipper FAP exposing a `scan` RPC command, or a Momentum patch to NFC's
RPC handler. Slated for v1.1, tracked under `flipper-app/`.

## Quickstart — demo without a Flipper

```bash
cd hub-app
npm install
npm run simulate     # opens the Even Hub simulator
# in your browser: http://localhost:5173/?t=mock
```

The mock transport returns synthetic OK responses for every command, so the
menu is navigable without a bridge or device.

## Quickstart — real end-to-end

```bash
# 1. Bridge APK
cd phone-bridge
npm install && npm run build && npx cap sync android
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./android/gradlew -p android assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# 2. Confirm bridge is alive
adb shell curl -s http://127.0.0.1:8765/health    # → "ok"
adb shell curl -s http://127.0.0.1:8765/favorites # → JSON list

# 3. Pair the Flipper to the phone (OS Bluetooth settings)
# 4. Sideload hub-app/flipctl.ehpk via the Even Hub dev portal

cd ../hub-app && npm run pack
```

## Gestures

| State         | Gesture            | Action                                      |
|---------------|--------------------|---------------------------------------------|
| Any menu      | 1 tap              | Pick highlighted item                       |
|               | 2+ taps            | Back / close menu                           |
|               | Scroll up/down     | Move cursor (skips separators)              |
|               | Text double-click  | Back / close menu                           |
| Mirror        | 1 tap              | Send OK to Flipper                          |
|               | 2 taps             | Send LEFT                                   |
|               | 3 taps             | Send RIGHT                                  |
|               | 4+ taps            | Return to home menu                         |
|               | Scroll up/down     | Send UP/DOWN                                |
|               | Text double-click  | Send BACK                                   |
| Standby       | 1 tap (first)      | Fire the armed favourite (legend → FIRED)   |
|               | 1 tap (after fire) | Fire again, then dismiss the app            |
|               | 2+ taps            | Dismiss the app                             |

## Bridge HTTP API

All commands POST to `http://127.0.0.1:8765/cmd` with JSON body
`{kind, arg?}` and return `{ok, message}`. Selected endpoints:

| Method | Path | Body | Effect |
|---|---|---|---|
| `GET`  | `/health`     | — | Health probe (`"ok"`) |
| `GET`  | `/status`     | — | `{link, port}` |
| `GET`  | `/favorites`  | — | `{favorites:[{name, path, app}]}` |
| `GET`  | `/frame?since=N` | — | Long-poll for newest 1024-byte Flipper frame; `X-Frame-Id` header |
| `POST` | `/cmd`        | `{kind:"input.up"\|"input.down"\|…}`         | Synthetic D-pad press to foreground app |
| `POST` | `/cmd`        | `{kind:"favorite.run", arg:"/ext/…"}`        | AppStart + AppLoadFile based on extension |
| `POST` | `/cmd`        | `{kind:"app.exit"}`                          | Drops the foreground app to desktop |
| `POST` | `/cmd`        | `{kind:"screen.start"\|"screen.stop"}`       | Toggle the screen stream |

## Platform support

- **Android**: works (Capacitor 7 + JDK 17 + Momentum mntm-012 firmware).
- **iOS**: not supported. iOS suspends localhost HTTP servers when the
  hosting app backgrounds, which would kill the bridge whenever the user
  switches to the Even App. A future iOS path would need to flip the
  architecture (CoreBluetooth peripheral/central split) or piggyback on the
  Even App's own background BLE permissions.

## References

- [Even Hub developer portal](https://hub.evenrealities.com/)
- [flipperdevices/flipperzero-protobuf](https://github.com/flipperdevices/flipperzero-protobuf) — the BLE Serial RPC schema
- [flipperdevices/Flipper-Android-App](https://github.com/flipperdevices/Flipper-Android-App) — reference implementation of the same RPC, on real hardware
- [Next-Flip/Momentum-Firmware](https://github.com/Next-Flip/Momentum-Firmware) — firmware fork verified working with this app
