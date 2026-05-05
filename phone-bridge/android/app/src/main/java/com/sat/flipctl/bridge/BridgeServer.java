package com.sat.flipctl.bridge;

import fi.iki.elonen.NanoHTTPD;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * HTTP gateway. Maps the Hub-app `/cmd` envelope onto Flipctl's text protocol
 * (`KIND[:ARG]\n` over BLE Serial). Flipctl on the Flipper handles the actual
 * input event injection, app launching, etc.
 *
 * (FlipperRpc remains in the codebase as a future hook — Momentum's BLE RPC
 * worker doesn't drain its stream buffer on this firmware version even with
 * allow_locked_rpc_ble + correct CCCD subscriptions.)
 */
public class BridgeServer extends NanoHTTPD {
    private final FlipperLink link;
    private final FlipperRpc rpc;
    private volatile byte[] latestFrame;
    private volatile long latestFrameId = 0;
    private final Object frameLock = new Object();
    private volatile AutoCloseable streamHandle;

    public BridgeServer(int port, FlipperLink link, FlipperRpc rpc) {
        super(port);
        this.link = link;
        this.rpc = rpc;
    }

    private synchronized void ensureStreaming() throws IOException {
        if (streamHandle != null) return;
        streamHandle = rpc.startScreenStream(data -> {
            synchronized (frameLock) {
                latestFrame = data;
                latestFrameId++;
                frameLock.notifyAll();
            }
        });
    }

    private synchronized void stopStreaming() {
        if (streamHandle == null) return;
        try { streamHandle.close(); } catch (Exception ignored) {}
        streamHandle = null;
    }

    @Override
    public Response serve(IHTTPSession session) {
        Method method = session.getMethod();
        String uri = session.getUri();
        Response response;

        if (method == Method.OPTIONS) {
            response = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
        } else if ("/health".equals(uri) && method == Method.GET) {
            response = newFixedLengthResponse(Response.Status.OK, "text/plain", "ok");
        } else if ("/status".equals(uri) && method == Method.GET) {
            String status = link == null ? "no_link" : link.getStatus();
            String json = "{\"link\":\"" + escapeJson(status) + "\",\"port\":" + getListeningPort() + "}";
            response = newFixedLengthResponse(Response.Status.OK, "application/json", json);
        } else if ("/frame".equals(uri) && method == Method.GET) {
            try { ensureStreaming(); } catch (IOException ignored) {}
            // Long-poll: ?since=N waits until latestFrameId > N (or 8s timeout).
            // Returns raw 1024-byte Flipper bitmap with X-Frame-Id header.
            long sinceId = 0;
            String q = session.getParms().get("since");
            if (q != null) try { sinceId = Long.parseLong(q); } catch (NumberFormatException ignored) {}
            byte[] f;
            long fid;
            synchronized (frameLock) {
                long deadline = System.currentTimeMillis() + 8000;
                while (latestFrameId <= sinceId) {
                    long remain = deadline - System.currentTimeMillis();
                    if (remain <= 0) break;
                    try { frameLock.wait(remain); } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                f = latestFrame;
                fid = latestFrameId;
            }
            if (f == null || fid <= sinceId) {
                response = newFixedLengthResponse(Response.Status.NO_CONTENT, "application/octet-stream", "");
            } else {
                response = newFixedLengthResponse(
                        Response.Status.OK, "application/octet-stream",
                        new java.io.ByteArrayInputStream(f), f.length);
                response.addHeader("X-Frame-Id", String.valueOf(fid));
            }
        } else if ("/cmd".equals(uri) && method == Method.POST) {
            response = handleCmd(session);
        } else if ("/favorites".equals(uri) && method == Method.GET) {
            response = handleFavorites();
        } else {
            response = newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found");
        }

        response.addHeader("Access-Control-Allow-Origin", "*");
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.addHeader("Access-Control-Allow-Headers", "Content-Type");
        response.addHeader("Access-Control-Expose-Headers", "X-Frame-Id");
        return response;
    }

    private Response handleCmd(IHTTPSession session) {
        Map<String, String> body = new HashMap<>();
        try {
            session.parseBody(body);
        } catch (IOException | ResponseException e) {
            return jsonResponse(false, "parse_error: " + e.getMessage());
        }
        String raw = body.getOrDefault("postData", "");

        String kind;
        String arg;
        try {
            JSONObject o = new JSONObject(raw);
            kind = o.getString("kind");
            arg = o.optString("arg", null);
            if (arg != null && (arg.equalsIgnoreCase("null") || arg.isEmpty())) arg = null;
        } catch (JSONException e) {
            return jsonResponse(false, "bad_json: " + e.getMessage());
        }

        if (link == null) return jsonResponse(false, "no_link");

        // input.* go through qFlipper RPC (Gui.SendInputEventRequest) so the
        // Flipper's *currently focused* app receives the synthesized button —
        // works without an on-Flipper FAP. Everything else falls back to the
        // text protocol that Flipctl's FAP speaks.
        try {
            switch (kind) {
                case "input.up":     rpc.sendInput("Up", "Short");    return jsonResponse(true, "OK:up");
                case "input.down":   rpc.sendInput("Down", "Short");  return jsonResponse(true, "OK:down");
                case "input.left":   rpc.sendInput("Left", "Short");  return jsonResponse(true, "OK:left");
                case "input.right":  rpc.sendInput("Right", "Short"); return jsonResponse(true, "OK:right");
                case "input.ok":     rpc.sendInput("Ok", "Short");    return jsonResponse(true, "OK:ok");
                case "input.back":   rpc.sendInput("Back", "Short");  return jsonResponse(true, "OK:back");
                case "input.long_back": rpc.sendInput("Back", "Long"); return jsonResponse(true, "OK:long_back");
                case "ping":         return jsonResponse(rpc.ping(), "OK:pong");
                case "screen.start": ensureStreaming(); return jsonResponse(true, "OK:streaming");
                case "screen.stop":  stopStreaming();   return jsonResponse(true, "OK:stopped");
                case "scan.nfc":     return jsonResponse(launchScanner("NFC"),  "OK:scan_nfc");
                case "scan.rfid":    return jsonResponse(launchScanner("125 kHz RFID"), "OK:scan_rfid");
                case "favorite.run": {
                    if (arg == null || arg.isEmpty()) return jsonResponse(false, "ERR:no_path");
                    primeForLaunch();
                    if (arg.endsWith(".fap")) {
                        // .fap files ARE apps — Loader.AppStart resolves a path
                        // straight to a FAP module. No AppLoadFile follow-up.
                        appStartWithRetry(arg, "RPC");
                        return jsonResponse(true, "OK:fap");
                    }
                    String appName = appNameForPath(arg);
                    if (appName == null) return jsonResponse(false, "ERR:unknown_ext");
                    appStartWithRetry(appName, "RPC");
                    // App needs to spin up its RPC handler before it can accept
                    // AppLoadFile — fire too soon and the loader returns
                    // ERROR_APP_NOT_RUNNING (21). 800 ms covers Sub-GHz / NFC /
                    // RFID / IR / iButton on this firmware.
                    sleepQuiet(800);
                    rpc.appLoadFile(arg);
                    return jsonResponse(true, "OK:run:" + appName);
                }
                case "app.exit": {
                    // "nothing to exit" (status 21) is the desired end state for
                    // a recovery action, so report ok regardless.
                    try { rpc.appExit(); }
                    catch (FlipperRpc.RpcException re) {
                        if (re.status != 21) return jsonResponse(false, "ERR:rpc_status_" + re.status);
                    }
                    return jsonResponse(true, "OK:exited");
                }
                case "desktop.unlock": rpc.desktopUnlock(); return jsonResponse(true, "OK:unlocked");
            }
        } catch (FlipperRpc.RpcException re) {
            // launchScanner throws with a human-readable message in the
            // recoverable cases — surface that to the hub-app verbatim so it
            // can show "press Back on Flipper" rather than "rpc_status_17".
            String m = re.getMessage();
            String surfaced = (m != null && !m.contains("status="))
                    ? m : ("ERR:rpc_status_" + re.status);
            return jsonResponse(false, surfaced);
        } catch (IOException ioe) {
            return jsonResponse(false, "ERR:" + ioe.getMessage());
        }

        // Fallback: text protocol via Flipctl FAP for any non-input.* commands
        // (favourites.list, nfc.scan, etc — kept for backward compat).
        String reply = link.sendCommand(kind, arg);
        boolean ok = reply.startsWith("OK");
        return jsonResponse(ok, reply);
    }

    /** Open NFC or RFID app in read-mode: AppStart with empty args (so the
     *  app shows its normal user-facing main menu — args="RPC" puts it into
     *  the official Flipper-app's headless takeover mode where the menu is
     *  hidden and Ok input does nothing). Wait for the menu to render, then
     *  nudge OK so the app enters its scan scene. */
    /** Open NFC or RFID *and navigate to the Read scene using ring inputs as
     *  proxy for the user's fingers*. We can't summon the scan scene via
     *  pure RPC — NFC/RFID's RPC handlers only support LoadFile/AppExit, and
     *  user-mode AppStart fails (loader busy) the moment another app is
     *  running. So:
     *   1. AppStart with args="RPC" — always allowed, lands in RpcScene.
     *   2. AppExit — cleanly tears down the RPC-mode app and unlocks the loader.
     *   3. Wait 1.5 s for the desktop to be foreground.
     *   4. AppStart with args="" — now the loader is empty, this works on a
     *      fresh boot or right after step 2.
     *   5. Wait 600 ms for the main menu to render, then send Ok to enter
     *      the Read scene (default cursor position on NFC and RFID).
     *
     *  If step 4 still fails (a stuck non-RPC app from a previous session
     *  whose user-mode UI didn't get cleaned up), we surface a clear "tap
     *  Back on Flipper" message instead of looping forever. */
    private boolean launchScanner(String appName) throws IOException {
        primeForLaunch();
        try {
            rpc.startApp(appName, "RPC");
            sleepQuiet(400);
            rpc.appExit();
            sleepQuiet(SETTLE_AFTER_EXIT_MS);
        } catch (FlipperRpc.RpcException re) {
            android.util.Log.i("BridgeServer", "rpc-flush status=" + re.status);
        }
        try {
            rpc.startApp(appName, "");
        } catch (FlipperRpc.RpcException re) {
            if (re.status == 17) {
                throw new FlipperRpc.RpcException(
                        "press Back on Flipper, then retry", 17);
            }
            throw re;
        }
        sleepQuiet(600);
        rpc.sendInput("Ok", "Short");
        return true;
    }

    /** Pre-launch hygiene.
     *
     *  ERROR_APP_SYSTEM_LOCKED (17) from AppStart means another app is
     *  already on the loader thread — `loader_do_is_locked()` simply checks
     *  `loader->app.thread != NULL`, nothing to do with lockscreen. So we
     *  must drop the running app's thread before the next AppStart.
     *
     *  AppExit cleanly tells RPC-mode apps to exit; user-mode apps (those
     *  started with args="") don't have an RPC handler, so AppExit returns
     *  status 21 and they keep running. For those, we send a Long Back —
     *  Flipper's convention for "exit to desktop" — which most user apps
     *  honour from any of their scenes. The exit is asynchronous, so we
     *  also sleep for a meaningful interval so the app's thread actually
     *  finishes before the next AppStart racetests `loader.app.thread`.
     *  DesktopUnlock at the end drops any lockscreen that the Long Back
     *  triggered if we were already at the desktop. */
    private static final long SETTLE_AFTER_EXIT_MS = 1500;

    private void primeForLaunch() {
        boolean exitedRpcApp = false;
        try { rpc.appExit(); exitedRpcApp = true; }
        catch (FlipperRpc.RpcException re) {
            if (re.status != 21) exitedRpcApp = true;
            android.util.Log.i("BridgeServer", "appExit status=" + re.status);
        } catch (java.io.IOException ioe) {
            android.util.Log.w("BridgeServer", "appExit failed", ioe);
        }

        if (!exitedRpcApp) {
            try { rpc.sendInput("Back", "Long"); }
            catch (FlipperRpc.RpcException re) {
                android.util.Log.i("BridgeServer", "long-back status=" + re.status);
            } catch (java.io.IOException ioe) {
                android.util.Log.w("BridgeServer", "long-back failed", ioe);
            }
        }
        sleepQuiet(SETTLE_AFTER_EXIT_MS);

        try { rpc.desktopUnlock(); }
        catch (FlipperRpc.RpcException re) {
            android.util.Log.i("BridgeServer", "desktopUnlock status=" + re.status);
        } catch (java.io.IOException ioe) {
            android.util.Log.w("BridgeServer", "desktopUnlock failed", ioe);
        }
    }

    /** AppStart with one retry-after-settle on ERROR_APP_SYSTEM_LOCKED.
     *  primeForLaunch usually clears the loader, but a non-cooperative user
     *  app (one whose Long-Back doesn't exit it) may need extra time. */
    private void appStartWithRetry(String name, String args) throws IOException {
        try { rpc.startApp(name, args); return; }
        catch (FlipperRpc.RpcException re) {
            if (re.status != 17) throw re;
            android.util.Log.w("BridgeServer", "AppStart locked, waiting + retrying once");
        }
        // Send another Long Back in case the previous one didn't take, then
        // wait again before retry.
        try { rpc.sendInput("Back", "Long"); } catch (Exception ignored) {}
        sleepQuiet(SETTLE_AFTER_EXIT_MS);
        rpc.startApp(name, args);
    }

    /** Map a Flipper file path to the app that owns its extension.
     *  Mirrors components/bridge/dao/.../FlipperKeyType.kt in the official app. */
    private static String appNameForPath(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return null;
        String ext = path.substring(dot + 1).toLowerCase();
        switch (ext) {
            case "sub":  return "Sub-GHz";
            case "rfid": return "125 kHz RFID";
            case "nfc":  return "NFC";
            case "ir":   return "Infrared";
            case "ibtn": return "iButton";
            default:     return null;
        }
    }

    private static void sleepQuiet(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }

    /** Read /ext/favorites.txt off the Flipper and return a JSON list of
     *  `{name, path, app}` rows that the hub-app can show in its menu. */
    private Response handleFavorites() {
        if (link == null) return jsonResponse(false, "no_link");
        byte[] raw;
        try {
            raw = readFavoritesBytes();
        } catch (FlipperRpc.RpcException re) {
            // Treat NOT_EXIST / INTERNAL as "no favourites file yet" — empty list.
            if (re.status == 14 || re.status == 15) {
                return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"favorites\":[]}");
            }
            return jsonResponse(false, "ERR:rpc_status_" + re.status);
        } catch (IOException ioe) {
            return jsonResponse(false, "ERR:" + ioe.getMessage());
        }
        StringBuilder sb = new StringBuilder("{\"favorites\":[");
        boolean first = true;
        String text = new String(raw, java.nio.charset.StandardCharsets.UTF_8);
        for (String line : text.split("\n")) {
            String path = line.trim();
            if (path.isEmpty()) continue;
            String app = appNameForPath(path);
            String name = displayNameForPath(path);
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"name\":\"").append(escapeJson(name)).append("\",")
              .append("\"path\":\"").append(escapeJson(path)).append("\",")
              .append("\"app\":\"").append(escapeJson(app == null ? "" : app)).append("\"}");
        }
        sb.append("]}");
        return newFixedLengthResponse(Response.Status.OK, "application/json", sb.toString());
    }

    private byte[] readFavoritesBytes() throws IOException {
        // Stock OFW + Momentum write to /ext/favorites.txt. Some forks symlink
        // /any/ to the user-writable storage — try that as a fallback.
        IOException last = null;
        for (String p : new String[] {"/ext/favorites.txt", "/any/favorites.txt"}) {
            try { return rpc.readFile(p); }
            catch (FlipperRpc.RpcException re) {
                last = re;
                if (re.status == 14 || re.status == 15) continue;  // NOT_EXIST/INTERNAL → try next
                throw re;
            }
        }
        throw last != null ? last : new IOException("favorites read failed");
    }

    private static String displayNameForPath(String path) {
        int slash = path.lastIndexOf('/');
        String base = slash >= 0 ? path.substring(slash + 1) : path;
        int dot = base.lastIndexOf('.');
        return dot > 0 ? base.substring(0, dot) : base;
    }

    private Response jsonResponse(boolean ok, String message) {
        String json = "{\"ok\":" + ok + ",\"message\":\"" + escapeJson(message) + "\"}";
        return newFixedLengthResponse(Response.Status.OK, "application/json", json);
    }

    private String escapeJson(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}
