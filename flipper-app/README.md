# flipper-app — Flipctl ufbt app

Flipper Zero firmware app that hijacks the BLE Serial profile and acts as a
command dispatcher. Bridge writes newline-terminated commands; Flipctl runs
them and replies via BLE notifications.

## Wire format

| Direction | Shape                            |
|-----------|----------------------------------|
| Bridge → Flipper (write)    | `KIND[:ARG]\n`            |
| Flipper → Bridge (notify)   | `OK[:detail]\n` or `ERR:<reason>\n` |

Examples:

| Send                        | Reply (Phase 1)              | Reply (Phase 2 target) |
|-----------------------------|------------------------------|-------------------------|
| `subghz.replay\n`           | `OK:subghz.replay_stub\n`    | `OK:played 0x1A2B3C\n` |
| `subghz.read:433920000\n`   | `OK:subghz.read_stub\n`      | `OK:saved /ext/subghz/raw_…\n` |
| `nfc.emulate:1\n`           | `OK:nfc.emulate_stub\n`      | `OK:emulating slot 1\n` |
| `system.lock\n`             | `OK:lock\n`                  | (real screen lock)      |
| `system.cancel\n`           | `OK:cancel\n`                | (cancel current op)     |
| `unknown.verb\n`            | `ERR:unknown_kind\n`         | `ERR:unknown_kind\n`    |

## BLE GATT (stock Flipper firmware)

The app uses the **stock Flipper BLE Serial service** — same one qFlipper /
the official Flipper mobile app uses for RPC. UUIDs from
[`targets/f7/ble_glue/services/serial_service_uuid.inc`](https://github.com/flipperdevices/flipperzero-firmware/blob/dev/targets/f7/ble_glue/services/serial_service_uuid.inc)
(little-endian byte arrays in firmware → canonical UUID strings shown):

| Role                                  | UUID                                       |
|---------------------------------------|--------------------------------------------|
| Service                               | `8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000`     |
| Flipper-side TX = Phone Notify        | `19ed82ae-ed21-4c9d-4145-228e61fe0000`     |
| Flipper-side RX = Phone Write         | `19ed82ae-ed21-4c9d-4145-228e62fe0000`     |
| Flow control                          | `19ed82ae-ed21-4c9d-4145-228e63fe0000`     |
| RPC status                            | `19ed82ae-ed21-4c9d-4145-228e64fe0000`     |

Because Flipctl reuses the stock Serial service (rather than registering a new
GATT service, which user apps can't do), launching Flipctl **takes over** the
serial channel from qFlipper RPC. This is fine for our use case — close
Flipctl when you want to use qFlipper / the Flipper mobile app again.

The phone bridge ([`../phone-bridge/`](../phone-bridge/)) connects to the
Flipper as a bonded device whose name starts with `Flipper ` (default device
naming pattern). Pair via OS Bluetooth settings once.

## Build

Requires [`ufbt`](https://github.com/flipperdevices/flipperzero-ufbt) and a
Flipper Zero connected via USB.

```bash
pip install --user ufbt           # one-time
ufbt update                       # pulls firmware SDK matching your Flipper

cd flipper-app
ufbt                              # builds dist/<target>/flipctl.fap
ufbt launch                       # uploads + runs on the connected Flipper
```

Once the app is running on the Flipper, the screen shows `Flipctl / ready`,
the BLE radio is advertising the Serial service, and the phone bridge can
connect. Press **Back** to exit (which restores the default RPC handler).

## Phase 2 — making the dispatcher real

Each branch of `dispatch_line()` in `flipctl.c` currently returns a stub. Wire
them to real subsystem APIs:

- `subghz.*`   — `subghz_worker_*`, `subghz_protocol_*`
- `nfc.*`      — `nfc_dev_*`
- `ir.*`       — `infrared_worker_*`
- `badusb.*`   — load `.txt` script via the BadUsb scene/worker
- `system.*`   — `furi_hal_*` calls (`furi_hal_power_off_screen`, etc.)

Each handler returns either `OK[:detail]` or `ERR:<reason>` to be sent via
`send_reply()`. Keep replies under `FLIPCTL_REPLY_BUFFER` (96 bytes) or bump
the buffer.

## Files

| File              | Purpose                                          |
|-------------------|--------------------------------------------------|
| `application.fam` | ufbt manifest                                    |
| `flipctl.h`       | App state struct + constants                     |
| `flipctl.c`       | RX callback, line parser, dispatcher, GUI loop   |
