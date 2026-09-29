package com.pythona.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;

/** Runs in :runtime and terminates only that process after pack activation. */
public final class RuntimeProcessRestartReceiver extends BroadcastReceiver {
    static final String ACTION_RESTART_RUNTIME = "com.pythona.app.RESTART_RUNTIME_PROCESS";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && ACTION_RESTART_RUNTIME.equals(intent.getAction())) {
            Process.killProcess(Process.myPid());
        }
    }
}
