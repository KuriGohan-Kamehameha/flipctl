package com.sat.flipctl.bridge;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * qFlipper-style RPC client. Speaks length-delimited Protocol Buffer Main
 * frames over the BLE Serial channel exposed by FlipperLink. Lets us run
 * Loader.LoadAppRequest (open NFC / RFID / favourites) and Storage.ReadRequest
 * (fetch /ext/favorites.txt) on stock firmware — no on-Flipper app needed.
 *
 * Hand-rolled protobuf to keep the APK small and avoid pulling in
 * protobuf-javalite for what amounts to four message types.
 *
 * Wire format on the BLE link, per direction:
 *   <varint length> <Main pb bytes>  <varint length> <Main pb bytes>  ...
 *
 * Schema (subset, from flipperdevices/flipperzero-protobuf @ dev):
 *   message Main {
 *     uint32 command_id = 1;
 *     CommandStatus command_status = 2;  // varint, 0 = OK
 *     bool has_next = 3;
 *     oneof content {
 *       PB_System.PingRequest      system_ping_request       =  5;
 *       PB_System.PingResponse     system_ping_response      =  6;
 *       PB_Storage.ReadRequest     storage_read_request      =  9;
 *       PB_Storage.ReadResponse    storage_read_response     = 10;
 *       PB_App.StartRequest        app_start_request         = 16;
 *       Empty                      empty                     =  4;
 *       ...
 *     }
 *   }
 *   message PB_Storage.ReadRequest  { string path = 1; }
 *   message PB_Storage.ReadResponse { File file = 1; }
 *   message PB_Storage.File { uint32 type=1; string name=2; uint32 size=3; bytes data=4; ... }
 *   message PB_App.StartRequest    { string name = 1; string args = 2; }
 *   message PB_System.PingRequest  { bytes data = 1; }
 *   message PB_System.PingResponse { bytes data = 1; }
 */
public class FlipperRpc {
    private static final String TAG = "FlipperRpc";

    // Main oneof field numbers.
    private static final int F_PING_REQ      = 5;
    private static final int F_PING_RESP     = 6;
    private static final int F_READ_REQ      = 9;
    private static final int F_READ_RESP     = 10;
    private static final int F_APP_START_REQ = 16;
    private static final int F_APP_EXIT_REQ                  = 47;
    private static final int F_APP_LOAD_FILE_REQ             = 48;
    private static final int F_APP_BUTTON_PRESS_REQ          = 49;
    private static final int F_APP_BUTTON_RELEASE_REQ        = 50;
    private static final int F_APP_BUTTON_PRESS_RELEASE_REQ  = 75;
    private static final int F_GUI_SEND_INPUT = 23;
    private static final int F_GUI_START_SCREEN_STREAM = 20;
    private static final int F_GUI_STOP_SCREEN_STREAM  = 21;
    private static final int F_GUI_SCREEN_FRAME        = 22;
    private static final int F_DESKTOP_IS_LOCKED_REQ   = 66;
    private static final int F_DESKTOP_UNLOCK_REQ      = 67;

    // Default RPC timeout — Storage.Read for a small text file should answer
    // in well under a second; Loader.LoadApp is similar.
    public static final long DEFAULT_TIMEOUT_MS = 4000;

    public static class RpcException extends IOException {
        public final int status;
        RpcException(String msg, int status) { super(msg); this.status = status; }
    }

    /** Decoded form of a single Main wire frame. */
    static class Main {
        int commandId;
        int commandStatus;
        boolean hasNext;
        int contentField;        // 0 = none / Empty
        byte[] contentBytes;     // raw sub-message bytes (length-delimited payload)
    }

    private final FlipperLink link;
    private final AtomicInteger nextCmdId = new AtomicInteger(1);
    private final java.util.concurrent.ConcurrentHashMap<Integer, LinkedBlockingQueue<Main>> pending =
            new java.util.concurrent.ConcurrentHashMap<>();

    // RX byte accumulator: notifications may carry partial frames or multiple
    // frames concatenated. We keep a rolling buffer and parse <varint length>
    // <Main bytes> repeatedly.
    private final ByteArrayOutputStream rxAcc = new ByteArrayOutputStream();
    private final Object rxLock = new Object();

    public FlipperRpc(FlipperLink link) {
        this.link = link;
        link.setListener(this::onBytes);
    }

    /** True if the underlying BLE link is up. */
    public boolean isReady() { return link.isConnected(); }

    /* ─── Public RPC calls ───────────────────────────────────────────── */

    /** Read a small file fully. Concatenates `data` chunks until has_next=false. */
    public byte[] readFile(String path) throws IOException {
        return readFile(path, DEFAULT_TIMEOUT_MS);
    }

    public byte[] readFile(String path, long timeoutMs) throws IOException {
        ByteArrayOutputStream subOut = new ByteArrayOutputStream();
        Wire.writeString(subOut, 1, path);
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_READ_REQ, subOut.toByteArray());

        ByteArrayOutputStream collected = new ByteArrayOutputStream();
        long deadline = System.currentTimeMillis() + timeoutMs;
        LinkedBlockingQueue<Main> q = pending.computeIfAbsent(cmdId, k -> new LinkedBlockingQueue<>());
        try {
            while (true) {
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) throw new IOException("readFile timeout");
                Main m = q.poll(remaining, TimeUnit.MILLISECONDS);
                if (m == null) throw new IOException("readFile timeout");
                if (m.commandStatus != 0) {
                    throw new RpcException("readFile status=" + m.commandStatus, m.commandStatus);
                }
                // ReadResponse { File file = 1 }
                if (m.contentField == F_READ_RESP && m.contentBytes != null) {
                    byte[] fileMsg = readMessageField(m.contentBytes, 1);
                    if (fileMsg != null) {
                        byte[] data = readBytesField(fileMsg, 4);  // File.data
                        if (data != null) collected.write(data);
                    }
                }
                if (!m.hasNext) return collected.toByteArray();
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        } finally {
            pending.remove(cmdId);
        }
    }

    /** Open an app on the Flipper. `name` is the appid (e.g. "Nfc", "lfrfid")
     *  or a path on /ext (e.g. "/ext/lfrfid/Regus.rfid"). */
    public void startApp(String name, String args) throws IOException {
        ByteArrayOutputStream subOut = new ByteArrayOutputStream();
        Wire.writeString(subOut, 1, name);
        if (args != null && !args.isEmpty()) Wire.writeString(subOut, 2, args);
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_APP_START_REQ, subOut.toByteArray());

        // Response is an Empty Main (just command_status). Wait for it.
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        if (m.commandStatus != 0) {
            throw new RpcException("startApp '" + name + "' status=" + m.commandStatus, m.commandStatus);
        }
    }

    /** Tell the currently-running app to load a file from Flipper storage.
     *  For SubGHz/Infrared single-signal files this triggers TX immediately;
     *  for NFC/RFID/iButton it loads the entry into emulation-armed state. */
    public void appLoadFile(String path) throws IOException {
        ByteArrayOutputStream sub = new ByteArrayOutputStream();
        Wire.writeString(sub, 1, path);
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_APP_LOAD_FILE_REQ, sub.toByteArray());
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        if (m.commandStatus != 0) {
            throw new RpcException("appLoadFile '" + path + "' status=" + m.commandStatus, m.commandStatus);
        }
    }

    /** Clear the desktop lockscreen. Required before AppStart on locked devices —
     *  the loader returns ERROR_APP_SYSTEM_LOCKED (17) until this fires.
     *  Idempotent: returns OK if already unlocked. */
    public void desktopUnlock() throws IOException {
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_DESKTOP_UNLOCK_REQ, new byte[0]);
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        if (m.commandStatus != 0) {
            throw new RpcException("desktopUnlock status=" + m.commandStatus, m.commandStatus);
        }
    }

    /** True if the Flipper is currently showing the lockscreen. */
    public boolean desktopIsLocked() throws IOException {
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_DESKTOP_IS_LOCKED_REQ, new byte[0]);
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        // Locked == OK status; unlocked == ERROR_APP_NOT_RUNNING (21) or similar.
        // Treat any non-zero status as "not locked / can't tell, proceed".
        return m.commandStatus == 0;
    }

    /** Exit the current app, returning to the desktop. */
    public void appExit() throws IOException {
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_APP_EXIT_REQ, new byte[0]);
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        if (m.commandStatus != 0) {
            throw new RpcException("appExit status=" + m.commandStatus, m.commandStatus);
        }
    }

    /** Press-and-release a named/indexed button in the running app — what the
     *  Flipper Android app fires from each universal-remote soft button (e.g.
     *  args="Power" or "Vol_up" while the Infrared app is foreground). */
    public void appButtonPressRelease(String args, int index) throws IOException {
        ByteArrayOutputStream sub = new ByteArrayOutputStream();
        if (args != null && !args.isEmpty()) Wire.writeString(sub, 1, args);
        Wire.writeUint32(sub, 2, index);
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_APP_BUTTON_PRESS_RELEASE_REQ, sub.toByteArray());
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        if (m.commandStatus != 0) {
            throw new RpcException("appButtonPressRelease '" + args + "' status=" + m.commandStatus, m.commandStatus);
        }
    }

    /**
     * Inject a synthetic button press into the Flipper's input subsystem.
     * key: Up/Down/Left/Right/Ok/Back. type: Press/Release/Short/Long/Repeat.
     * For a tap-equivalent, use type=Short.
     */
    public void sendInput(String key, String type) throws IOException {
        int keyEnum = parseInputKey(key);
        int typeEnum = parseInputType(type);
        ByteArrayOutputStream sub = new ByteArrayOutputStream();
        Wire.writeUint32(sub, 1, keyEnum);
        Wire.writeUint32(sub, 2, typeEnum);
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_GUI_SEND_INPUT, sub.toByteArray());
        Main m = awaitResponse(cmdId, DEFAULT_TIMEOUT_MS);
        if (m.commandStatus != 0) {
            throw new RpcException("sendInput status=" + m.commandStatus, m.commandStatus);
        }
    }

    private static int parseInputKey(String n) {
        switch (n) {
            case "Up":    return 0;
            case "Down":  return 1;
            case "Right": return 2;
            case "Left":  return 3;
            case "Ok":    return 4;
            case "Back":  return 5;
            default: throw new IllegalArgumentException("bad input key: " + n);
        }
    }

    private static int parseInputType(String n) {
        switch (n) {
            case "Press":   return 0;
            case "Release": return 1;
            case "Short":   return 2;
            case "Long":    return 3;
            case "Repeat":  return 4;
            default: throw new IllegalArgumentException("bad input type: " + n);
        }
    }

    public interface ScreenListener {
        /** data is the firmware's raw 128x64 1bpp frame (1024 bytes, vertical-page layout). */
        void onFrame(byte[] data);
    }

    // Streamed frames arrive with command_id=0 (proto3 default elided) so we
    // can't key by id — a single global listener is fine since there's only
    // ever one screen stream in flight.
    private volatile ScreenListener screenListener;

    public AutoCloseable startScreenStream(ScreenListener listener) throws IOException {
        screenListener = listener;
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_GUI_START_SCREEN_STREAM, new byte[0]);
        return () -> {
            screenListener = null;
            int stopCmdId = nextCmdId.incrementAndGet();
            try {
                send(stopCmdId, F_GUI_STOP_SCREEN_STREAM, new byte[0]);
            } catch (IOException ignored) {}
        };
    }

    /** Sanity check — sends a Ping and waits for the matching Pong. */
    public boolean ping() throws IOException {
        ByteArrayOutputStream subOut = new ByteArrayOutputStream();
        Wire.writeBytes(subOut, 1, new byte[]{0x70, 0x6f, 0x6e, 0x67}); // "pong" payload, echoed
        int cmdId = nextCmdId.incrementAndGet();
        send(cmdId, F_PING_REQ, subOut.toByteArray());
        Main m = awaitResponse(cmdId, 1500);
        return m.commandStatus == 0 && m.contentField == F_PING_RESP;
    }

    /* ─── Internals ──────────────────────────────────────────────────── */

    private Main awaitResponse(int cmdId, long timeoutMs) throws IOException {
        LinkedBlockingQueue<Main> q = pending.computeIfAbsent(cmdId, k -> new LinkedBlockingQueue<>());
        try {
            Main m = q.poll(timeoutMs, TimeUnit.MILLISECONDS);
            if (m == null) throw new IOException("rpc timeout id=" + cmdId);
            return m;
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted");
        } finally {
            pending.remove(cmdId);
        }
    }

    private void send(int cmdId, int contentField, byte[] subBytes) throws IOException {
        ByteArrayOutputStream main = new ByteArrayOutputStream();
        Wire.writeUint32(main, 1, cmdId);
        // command_status defaults 0; has_next defaults false; skip when default.
        Wire.writeMessage(main, contentField, subBytes);
        byte[] mainBytes = main.toByteArray();

        ByteArrayOutputStream framed = new ByteArrayOutputStream();
        Wire.writeRawVarint(framed, mainBytes.length);
        framed.write(mainBytes);
        byte[] wire = framed.toByteArray();

        Log.i(TAG, "TX cmdId=" + cmdId + " field=" + contentField + " " + hex(wire));
        if (!link.write(wire)) throw new IOException("BLE write failed (link not ready)");
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 3);
        for (byte v : b) sb.append(String.format("%02x ", v & 0xff));
        return sb.toString().trim();
    }

    /** Called by FlipperLink on every notification chunk. Frames + dispatches. */
    private void onBytes(byte[] chunk) {
        Log.i(TAG, "RX " + chunk.length + "B " + hex(chunk));
        synchronized (rxLock) {
            try { rxAcc.write(chunk); } catch (IOException ignored) {}
            byte[] buf = rxAcc.toByteArray();
            int consumed = 0;
            while (true) {
                int[] off = new int[]{consumed};
                long len = Wire.tryReadVarint(buf, off);
                if (len < 0) break;                       // incomplete varint
                int msgStart = off[0];
                if (buf.length - msgStart < len) break;   // incomplete message
                byte[] mainBytes = new byte[(int) len];
                System.arraycopy(buf, msgStart, mainBytes, 0, (int) len);
                consumed = msgStart + (int) len;

                Main m = decodeMain(mainBytes);
                // Streamed frames go to the screen listener registered for the
                // stream's command_id. Other Mains route to the awaiting queue.
                if (m.contentField == F_GUI_SCREEN_FRAME) {
                    ScreenListener sl = screenListener;
                    if (sl != null && m.contentBytes != null) {
                        byte[] data = readBytesField(m.contentBytes, 1);
                        if (data != null) sl.onFrame(data);
                    }
                } else {
                    LinkedBlockingQueue<Main> q = pending.get(m.commandId);
                    if (q != null) q.offer(m);
                    else Log.w(TAG, "unmatched main cmdId=" + m.commandId);
                }
            }
            if (consumed > 0) {
                byte[] left = new byte[buf.length - consumed];
                System.arraycopy(buf, consumed, left, 0, left.length);
                rxAcc.reset();
                try { rxAcc.write(left); } catch (IOException ignored) {}
            }
        }
    }

    private static Main decodeMain(byte[] bytes) {
        Main m = new Main();
        int pos = 0;
        while (pos < bytes.length) {
            int[] off = new int[]{pos};
            long tag = Wire.tryReadVarint(bytes, off);
            if (tag < 0) break;
            pos = off[0];
            int field = (int) (tag >>> 3);
            int wire = (int) (tag & 0x7);
            switch (field) {
                case 1: { // command_id (varint)
                    long v = Wire.tryReadVarint(bytes, off);
                    if (v < 0) return m;
                    m.commandId = (int) v;
                    pos = off[0];
                    break;
                }
                case 2: { // command_status (varint)
                    long v = Wire.tryReadVarint(bytes, off);
                    if (v < 0) return m;
                    m.commandStatus = (int) v;
                    pos = off[0];
                    break;
                }
                case 3: { // has_next (varint)
                    long v = Wire.tryReadVarint(bytes, off);
                    if (v < 0) return m;
                    m.hasNext = v != 0;
                    pos = off[0];
                    break;
                }
                default: {
                    if (wire == 2) {
                        long subLen = Wire.tryReadVarint(bytes, off);
                        if (subLen < 0) return m;
                        int subStart = off[0];
                        if (bytes.length - subStart < subLen) return m;
                        byte[] sub = new byte[(int) subLen];
                        System.arraycopy(bytes, subStart, sub, 0, (int) subLen);
                        m.contentField = field;
                        m.contentBytes = sub;
                        pos = subStart + (int) subLen;
                    } else {
                        // skip varint / fixed
                        if (wire == 0) { Wire.tryReadVarint(bytes, off); pos = off[0]; }
                        else { return m; }  // unsupported wire type
                    }
                    break;
                }
            }
        }
        return m;
    }

    /** From a sub-message body, return the bytes of length-delimited field N, or null. */
    private static byte[] readMessageField(byte[] bytes, int wantField) {
        return readField(bytes, wantField, 2);
    }

    /** From a sub-message body, return raw bytes of `bytes`-typed field N. */
    private static byte[] readBytesField(byte[] bytes, int wantField) {
        return readField(bytes, wantField, 2);
    }

    private static byte[] readField(byte[] bytes, int wantField, int wantWire) {
        int pos = 0;
        while (pos < bytes.length) {
            int[] off = new int[]{pos};
            long tag = Wire.tryReadVarint(bytes, off);
            if (tag < 0) return null;
            int field = (int) (tag >>> 3);
            int wire = (int) (tag & 0x7);
            pos = off[0];
            if (wire == 2) {
                long len = Wire.tryReadVarint(bytes, off);
                if (len < 0) return null;
                int start = off[0];
                if (bytes.length - start < len) return null;
                if (field == wantField && wire == wantWire) {
                    byte[] out = new byte[(int) len];
                    System.arraycopy(bytes, start, out, 0, (int) len);
                    return out;
                }
                pos = start + (int) len;
            } else if (wire == 0) {
                long ignored = Wire.tryReadVarint(bytes, off);
                if (ignored < 0) return null;
                pos = off[0];
            } else {
                return null;  // unsupported
            }
        }
        return null;
    }

    /* ─── Wire helpers ───────────────────────────────────────────────── */

    static class Wire {
        static void writeRawVarint(ByteArrayOutputStream out, long v) {
            while (true) {
                if ((v & ~0x7FL) == 0) {
                    out.write((int) v);
                    return;
                }
                out.write((int) (v & 0x7F) | 0x80);
                v >>>= 7;
            }
        }

        static long tryReadVarint(byte[] buf, int[] off) {
            long result = 0;
            int shift = 0;
            int p = off[0];
            while (true) {
                if (p >= buf.length) return -1;        // not enough bytes
                int b = buf[p++] & 0xFF;
                result |= (long) (b & 0x7F) << shift;
                if ((b & 0x80) == 0) {
                    off[0] = p;
                    return result;
                }
                shift += 7;
                if (shift >= 64) return -1;            // malformed
            }
        }

        static void writeTag(ByteArrayOutputStream out, int field, int wire) {
            writeRawVarint(out, ((long) field << 3) | wire);
        }

        static void writeUint32(ByteArrayOutputStream out, int field, int v) {
            if (v == 0) return;            // proto3 default; skip on the wire
            writeTag(out, field, 0);
            writeRawVarint(out, v & 0xFFFFFFFFL);
        }

        static void writeBool(ByteArrayOutputStream out, int field, boolean v) {
            if (!v) return;
            writeTag(out, field, 0);
            out.write(1);
        }

        static void writeString(ByteArrayOutputStream out, int field, String s) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            writeBytes(out, field, b);
        }

        static void writeBytes(ByteArrayOutputStream out, int field, byte[] b) {
            writeTag(out, field, 2);
            writeRawVarint(out, b.length);
            try { out.write(b); } catch (IOException ignored) {}
        }

        static void writeMessage(ByteArrayOutputStream out, int field, byte[] subBytes) {
            writeTag(out, field, 2);
            writeRawVarint(out, subBytes.length);
            try { out.write(subBytes); } catch (IOException ignored) {}
        }
    }
}
