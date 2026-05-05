package com.sat.flipctl.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.IOException;

public class BridgeService extends Service {
    private static final String TAG = "FlipctlBridge";
    private static final String CHANNEL_ID = "flipctl-bridge";
    private static final int NOTIFICATION_ID = 1;
    private static final int PORT = 8765;

    private BridgeServer server;
    private FlipperLink flipperLink;
    private FlipperRpc flipperRpc;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startInForeground();
        flipperLink = new FlipperLink(this);
        flipperRpc = new FlipperRpc(flipperLink);
        flipperLink.start();
        startServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Re-kick the link in case BLUETOOTH_CONNECT was just granted by the
        // user — MainActivity calls startService again after a permission grant.
        if (flipperLink != null) flipperLink.start();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (server != null) {
            server.stop();
            server = null;
            Log.i(TAG, "BridgeServer stopped");
        }
        if (flipperLink != null) {
            flipperLink.stop();
            flipperLink = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startServer() {
        try {
            server = new BridgeServer(PORT, flipperLink, flipperRpc);
            // /cmd RPC calls block up to FlipperRpc.DEFAULT_TIMEOUT_MS (4s);
            // give NanoHTTPD's per-socket read timeout some headroom over that.
            server.start(8000, false);
            Log.i(TAG, "BridgeServer listening on :" + PORT);
        } catch (IOException e) {
            Log.e(TAG, "BridgeServer failed to start", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Flipctl Bridge", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps the Flipper bridge alive while Even App is foreground.");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private void startInForeground() {
        Intent activityIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, activityIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Flipctl Bridge")
                .setContentText("Listening on 127.0.0.1:" + PORT)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }
}
