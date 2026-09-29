package com.pythona.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;

/** Explicitly restarts only the network-enabled DSH process. */
public final class DshProcessRestartReceiver extends BroadcastReceiver {
    static final String ACTION_RESTART_DSH = "com.pythona.app.RESTART_DSH_PROCESS";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && ACTION_RESTART_DSH.equals(intent.getAction())) {
            Process.killProcess(Process.myPid());
        }
    }
}
