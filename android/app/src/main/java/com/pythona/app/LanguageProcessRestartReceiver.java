package com.pythona.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Process;

/**
 * Runs in :language and terminates only that process after the Python
 * environment changes. The Activity's persistent Messenger binding then
 * reconnects a fresh Jedi interpreter with the newly validated import paths.
 */
public final class LanguageProcessRestartReceiver extends BroadcastReceiver {
    static final String ACTION_RESTART_LANGUAGE =
        "com.pythona.app.RESTART_LANGUAGE_PROCESS";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && ACTION_RESTART_LANGUAGE.equals(intent.getAction())) {
            Process.killProcess(Process.myPid());
        }
    }
}
