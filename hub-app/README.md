# Flipctl

Mirror your Flipper Zero on the Even Realities G2 HUD and control it with the
R1 ring. Includes a one-tap launcher for any signal in your Flipper's
`favorites.txt` (Sub-GHz, Infrared, NFC, RFID, iButton, FAPs).

## What it does

- **Live screen mirror** — the Flipper's 128×64 OLED is streamed to the HUD,
  scaled to 192×96 at 70% brightness so it sits comfortably alongside the
  rest of the HUD content.
- **Ring as remote** — the R1 ring acts as a D-pad/OK/Back for whatever
  Flipper UI is currently in focus.
- **Favourites picker** — a ring-driven overlay menu shows everything in the
  Flipper's `/ext/favorites.txt`. One tap fires the corresponding app:
  Sub-GHz signals transmit on load, Infrared signals emit, NFC/RFID/iButton
  enter emulation-armed state, FAPs launch directly.
- **Recovery** — a built-in "Exit Flipper app" item drops the foreground app
  back to the Flipper desktop so the next launch starts cleanly.

## Architecture

```
   ┌─────────────┐   BLE Serial   ┌──────────────┐   loopback HTTP   ┌─────────┐
   │ Flipper Zero│ ◄────────────► │  Phone bridge│ ◄───────────────► │ Hub app │
   │ (Momentum)  │                │  (companion) │                   │  (G2)   │
   └─────────────┘                └──────────────┘                   └─────────┘
```

The Hub app is pure TypeScript running in the Even Hub webview. It never
touches BLE directly — all Flipper I/O is delegated to a small companion
process on the phone (`Flipctl Bridge`, available separately) that owns the
BLE Serial channel and exposes a localhost-only HTTP API on `127.0.0.1:8765`.

## Gestures

| State        | Gesture                | Action                         |
|--------------|------------------------|--------------------------------|
| Mirror mode  | 1 tap                  | Send OK to Flipper             |
|              | 2 taps                 | Send LEFT                      |
|              | 3 taps                 | Send RIGHT                     |
|              | 4+ taps                | Open favourites menu           |
|              | Scroll up/down         | Send UP/DOWN                   |
|              | Text double-click      | Send BACK                      |
| Menu mode    | 1 tap                  | Pick highlighted item          |
|              | 2+ taps                | Close menu (back to mirror)    |
|              | Scroll up/down         | Move cursor (skips separators) |
|              | Text double-click      | Close menu                     |

## URL parameters

Position the mirror window in the HUD and toggle dev modes via query string:

| Param         | Values            | Effect                                      |
|---------------|-------------------|---------------------------------------------|
| `pos`         | `c` / `tl` / `tr` | Centred (default) / top-left / top-right    |
| `t`           | `http` / `mock`   | Transport (default `http`)                  |
| `bridge`      | URL               | Override bridge address (default `http://127.0.0.1:8765`) |
| `debug`       | `1`               | Replace status line with per-frame timing   |

## Reviewer setup (no Flipper / no bridge)

```bash
npm install
npm run simulate     # opens the Even Hub simulator
# in your browser: http://localhost:5173/?t=mock
```

The mock transport returns synthetic OK responses for every command, so the
menu is navigable without a bridge or device. The mirror image stays blank
(no frames will arrive), but ring-driven navigation, the favourites menu,
and the status line all behave as on production.

## Build

```bash
npm install
npm run build
npm run pack         # produces flipctl.ehpk
```

## Files

| File                      | Purpose                                      |
|---------------------------|----------------------------------------------|
| `app.json`                | Even Hub manifest (`com.sat.flipctl`)        |
| `src/main.ts`             | Bridge handshake, mirror pipeline, menu      |
| `src/screen.ts`           | Flipper 1bpp frame → PNG encoder             |
| `src/commands.ts`         | Command catalog (id/kind/label/arg)          |
| `src/transport/http.ts`   | HTTP transport to phone-resident bridge      |
| `src/transport/mock.ts`   | Mock transport for simulator demos           |
| `src/transport/index.ts`  | `pickTransport()` URL-param toggle           |
