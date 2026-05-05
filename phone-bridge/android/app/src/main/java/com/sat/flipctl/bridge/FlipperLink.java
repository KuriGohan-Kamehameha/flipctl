package com.sat.flipctl.bridge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Owns the BLE central link to a paired Flipper Zero. Speaks RAW BYTES on the
 * stock BLE Serial profile — no on-Flipper app required. Higher-level framing
 * and protobuf RPC live in FlipperRpc.
 *
 * Wire UUIDs come from
 * flipperzero-firmware/targets/f7/ble_glue/services/serial_service_uuid.inc:
 *   SVC = 8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000
 *   bridge writes  → 19ed82ae-...-228e62fe0000  (Flipper RX)
 *   bridge notifies← 19ed82ae-...-228e61fe0000  (Flipper TX)
 */
@SuppressLint("MissingPermission")
public class FlipperLink {
    private static final String TAG = "FlipperLink";

    public static final UUID SVC_UUID = UUID.fromString("8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000");
    public static final UUID TX_UUID  = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e62fe0000");
    public static final UUID RX_UUID  = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e61fe0000");
    public static final UUID FLOW_UUID = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e63fe0000");
    public static final UUID STATUS_UUID = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e64fe0000");
    public static final UUID CCCD     = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // Substring hints (case-insensitive) for picking a bonded Flipper. Custom
    // firmware (Momentum, XFW, RogueMaster) often renames the device; add to
    // this list if your bond name doesn't match.
    private static final String[] NAME_HINTS = {
            "flipper", "kulu", "kulf", "momentum", "rogue", "xtreme", "unleashed",
    };

    private static final int  MTU_REQUEST = 247;

    public interface ByteListener {
        void onBytes(byte[] data);
    }

    private final Context context;
    private final BluetoothManager btManager;

    private BluetoothDevice device;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic txChar;
    private BluetoothGattCharacteristic rxChar;
    private BluetoothGattCharacteristic flowChar;
    private BluetoothGattCharacteristic statusChar;
    // CCCD-write queue: Android only allows ONE descriptor write at a time, so we
    // chain RX → FLOW → STATUS subscriptions through the onDescriptorWrite callback.
    private final java.util.LinkedList<BluetoothGattCharacteristic> pendingNotifSubscribes = new java.util.LinkedList<>();
    private final AtomicBoolean discovering = new AtomicBoolean(false);
    private final AtomicBoolean setupComplete = new AtomicBoolean(false);

    private final AtomicBoolean ready = new AtomicBoolean(false);
    private final Object writeLock = new Object();
    private volatile ByteListener listener;

    // Legacy text-protocol path (Flipctl-on-Flipper). Kept alongside the
    // raw byte API so BridgeServer can fall back when no FlipperRpc is wired.
    private static final long TEXT_REQUEST_TIMEOUT_MS = 5000;
    private final Object commandLock = new Object();
    private final AtomicReference<CountDownLatch> awaitingReply = new AtomicReference<>();
    private final AtomicReference<String> lastReply = new AtomicReference<>();

    public FlipperLink(Context ctx) {
        this.context = ctx.getApplicationContext();
        this.btManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
    }

    public void setListener(ByteListener l) {
        this.listener = l;
    }

    public synchronized void start() {
        if (gatt != null) return;
        if (!hasConnectPermission()) {
            Log.w(TAG, "BLUETOOTH_CONNECT not granted; will retry after MainActivity gets it");
            return;
        }
        if (btManager == null) {
            Log.e(TAG, "no BluetoothManager available");
            return;
        }
        BluetoothAdapter adapter = btManager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            Log.w(TAG, "Bluetooth disabled");
            return;
        }
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        BluetoothDevice pick = null;
        Log.i(TAG, "scanning " + bonded.size() + " bonded devices");
        for (BluetoothDevice d : bonded) {
            String name = d.getName();
            int type = d.getType();
            Log.i(TAG, "  bonded: " + (name != null ? name : "(null)") +
                    " [" + d.getAddress() + ", " + bondTypeStr(type) + "]");
            if (type != BluetoothDevice.DEVICE_TYPE_LE && type != BluetoothDevice.DEVICE_TYPE_DUAL) continue;
            if (name == null) continue;
            if (name.startsWith("Control ")) continue;
            if (pick != null) continue;
            String lower = name.toLowerCase();
            for (String hint : NAME_HINTS) {
                if (lower.contains(hint)) { pick = d; break; }
            }
        }
        if (pick == null) {
            Log.w(TAG, "no Flipper-shaped bonded device found — none of " +
                    java.util.Arrays.toString(NAME_HINTS) +
                    " matched any bonded name. Add your device's name to NAME_HINTS in FlipperLink.java.");
            return;
        }
        Log.i(TAG, "picking " + pick.getName() + " [" + pick.getAddress() + "]");
        device = pick;
        // autoConnect=false → fresh GAP each connect, faster initial handshake.
        // Each disconnect we'll re-call start() to reconnect (handled in onConnectionStateChange).
        gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
    }

    public synchronized void stop() {
        ready.set(false);
        if (gatt != null) {
            try { gatt.disconnect(); } catch (Exception ignored) {}
            try { gatt.close(); } catch (Exception ignored) {}
            gatt = null;
        }
        device = null;
        txChar = null;
        rxChar = null;
    }

    public boolean isConnected() {
        return ready.get();
    }

    public String getStatus() {
        if (!hasConnectPermission()) return "permission_missing";
        if (btManager == null) return "no_bt_manager";
        BluetoothAdapter adapter = btManager.getAdapter();
        if (adapter == null) return "no_adapter";
        if (!adapter.isEnabled()) return "bt_off";
        if (device == null) return "no_paired_device";
        if (!ready.get()) return "connecting";
        return "connected:" + device.getName();
    }

    /**
     * Push raw bytes to the Flipper over the BLE Serial Write characteristic.
     * Caller is responsible for any framing (e.g. protobuf delimited length).
     * Returns false if not ready or the GATT write couldn't be dispatched.
     */
    /** Text protocol: write "KIND[:ARG]\n", wait for newline-terminated reply. */
    public String sendCommand(String kind, String arg) {
        if (!ready.get() || txChar == null || gatt == null) return "ERR:not_connected";
        synchronized (commandLock) {
            String payload = (arg == null || arg.isEmpty()) ? kind + "\n" : kind + ":" + arg + "\n";
            CountDownLatch latch = new CountDownLatch(1);
            awaitingReply.set(latch);
            lastReply.set(null);
            // Install a one-shot listener that captures the next notify chunk.
            ByteListener prev = listener;
            listener = data -> {
                String reply = new String(data, StandardCharsets.UTF_8).trim();
                lastReply.set(reply);
                CountDownLatch l = awaitingReply.get();
                if (l != null) l.countDown();
            };
            try {
                if (!write(payload.getBytes(StandardCharsets.UTF_8))) {
                    return "ERR:write_dispatch_failed";
                }
                if (!latch.await(TEXT_REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return "ERR:timeout";
                String reply = lastReply.get();
                return reply == null ? "ERR:empty_reply" : reply;
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return "ERR:interrupted";
            } finally {
                awaitingReply.set(null);
                listener = prev;
            }
        }
    }

    public boolean write(byte[] data) {
        if (!ready.get() || txChar == null || gatt == null) return false;
        synchronized (writeLock) {
            txChar.setValue(data);
            // qFlipper-style RPC streams bytes; the Flipper RX char advertises
            // WRITE_NO_RESPONSE which avoids the Android BLE stack waiting for
            // an ack between back-to-back writes (and which seems to be the
            // mode the firmware actually services).
            txChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            boolean ok = gatt.writeCharacteristic(txChar);
            Log.i(TAG, "write " + data.length + "B dispatched=" + ok);
            return ok;
        }
    }

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static String bondTypeStr(int t) {
        switch (t) {
            case BluetoothDevice.DEVICE_TYPE_CLASSIC: return "CLASSIC";
            case BluetoothDevice.DEVICE_TYPE_LE:      return "LE";
            case BluetoothDevice.DEVICE_TYPE_DUAL:    return "DUAL";
            default:                                  return "UNKNOWN(" + t + ")";
        }
    }

    private void subscribeNext(BluetoothGatt g) {
        BluetoothGattCharacteristic next = pendingNotifSubscribes.pollFirst();
        if (next == null) {
            ready.set(true);
            Log.i(TAG, "FlipperLink ready; reading RPC_STATUS to verify");
            if (statusChar != null) g.readCharacteristic(statusChar);
            return;
        }
        g.setCharacteristicNotification(next, true);
        BluetoothGattDescriptor cccd = next.getDescriptor(CCCD);
        if (cccd == null) {
            Log.w(TAG, "no CCCD on " + next.getUuid() + ", skipping");
            subscribeNext(g);
            return;
        }
        // The Flipper's TX char (suffix 61fe) is INDICATE-only; FLOW (63fe) +
        // STATUS (64fe) are NOTIFY. The CCCD value differs between the two.
        boolean isIndicate = (next.getProperties() & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0;
        byte[] value = isIndicate
                ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
        Log.i(TAG, "subscribing " + next.getUuid() + " mode=" + (isIndicate ? "indicate" : "notify"));
        cccd.setValue(value);
        g.writeDescriptor(cccd);
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                Log.i(TAG, "connected; requesting HIGH priority + MTU=" + MTU_REQUEST);
                // qFlipper does this — drops connection interval to ~7ms for low-latency RPC.
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                g.requestMtu(MTU_REQUEST);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                ready.set(false);
                discovering.set(false);
                setupComplete.set(false);
                txChar = null;
                rxChar = null;
                flowChar = null;
                statusChar = null;
                if (gatt != null) {
                    try { gatt.close(); } catch (Exception ignored) {}
                    gatt = null;
                }
                Log.i(TAG, "disconnected status=" + status + "; will reconnect after 2s");
                // Schedule reconnect via the main looper so we don't reuse the dead gatt.
                new android.os.Handler(android.os.Looper.getMainLooper())
                        .postDelayed(this::reconnectAttempt, 2000);
            }
        }

        private void reconnectAttempt() {
            if (device != null && gatt == null) {
                Log.i(TAG, "reconnect attempt to " + device.getAddress());
                gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            if (!discovering.compareAndSet(false, true)) {
                Log.i(TAG, "mtu=" + mtu + " (already discovering, skipping duplicate)");
                return;
            }
            Log.i(TAG, "mtu=" + mtu + " status=" + status + "; discovering services");
            g.discoverServices();
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (!setupComplete.compareAndSet(false, true)) {
                Log.i(TAG, "onServicesDiscovered: setup already done, skipping");
                return;
            }
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "discoverServices failed: " + status);
                return;
            }
            BluetoothGattService svc = g.getService(SVC_UUID);
            if (svc == null) {
                Log.e(TAG, "Serial service " + SVC_UUID + " not present");
                return;
            }
            txChar = svc.getCharacteristic(TX_UUID);
            rxChar = svc.getCharacteristic(RX_UUID);
            flowChar = svc.getCharacteristic(FLOW_UUID);
            statusChar = svc.getCharacteristic(STATUS_UUID);
            if (txChar == null || rxChar == null) {
                Log.e(TAG, "TX/RX characteristics missing");
                return;
            }
            // qFlipper subscribes to RX, FLOW_CONTROL and RPC_STATUS — emulate.
            pendingNotifSubscribes.clear();
            pendingNotifSubscribes.add(rxChar);
            if (flowChar != null) pendingNotifSubscribes.add(flowChar);
            if (statusChar != null) pendingNotifSubscribes.add(statusChar);
            subscribeNext(g);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor desc, int status) {
            if (!CCCD.equals(desc.getUuid())) return;
            UUID c = desc.getCharacteristic().getUuid();
            Log.i(TAG, "CCCD write done char=" + c + " status=" + status);
            // Walk to the next char in the queue.
            subscribeNext(g);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            Log.i(TAG, "onCharacteristicWrite status=" + status);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            byte[] v = ch.getValue();
            StringBuilder sb = new StringBuilder();
            if (v != null) for (byte b : v) sb.append(String.format("%02x ", b & 0xff));
            Log.i(TAG, "onCharacteristicRead uuid=" + ch.getUuid() + " status=" + status +
                    " val=[" + sb.toString().trim() + "]");
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            Log.i(TAG, "onCharacteristicChanged uuid=" + ch.getUuid());
            byte[] value = ch.getValue();
            if (value == null || value.length == 0) return;
            if (!RX_UUID.equals(ch.getUuid())) return;
            ByteListener l = listener;
            if (l != null) l.onBytes(value);
        }
    };
}
