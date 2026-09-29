package com.pythona.app;

import android.os.FileObserver;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/** Recursive, debounced inotify bridge for writes made outside the UI process. */
final class WorkspaceFileWatcher implements AutoCloseable {
    private static final String TAG = "PythonA.WorkspaceWatch";
    private static final long DEBOUNCE_MILLIS = 80;
    private static final int EVENTS =
        FileObserver.CLOSE_WRITE
            | FileObserver.CREATE
            | FileObserver.DELETE
            | FileObserver.MOVED_FROM
            | FileObserver.MOVED_TO
            | FileObserver.DELETE_SELF
            | FileObserver.MOVE_SELF;

    private final WorkspaceRepository repository;
    private final HandlerThread thread;
    private final Handler handler;
    private final Map<String, FileObserver> observers = new HashMap<>();
    private final Runnable reconcile = this::reconcileNow;
    private boolean closed;

    WorkspaceFileWatcher(WorkspaceRepository repository) {
        this.repository = repository;
        thread = new HandlerThread("PythonA.workspace-watcher");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(this::rebuildObservers);
    }

    @Override
    public void close() {
        handler.post(() -> {
            if (closed) return;
            closed = true;
            handler.removeCallbacks(reconcile);
            for (FileObserver observer : new ArrayList<>(observers.values())) {
                observer.stopWatching();
            }
            observers.clear();
            thread.quitSafely();
        });
    }

    private void scheduleReconcile() {
        if (closed) return;
        handler.removeCallbacks(reconcile);
        handler.postDelayed(reconcile, DEBOUNCE_MILLIS);
    }

    private void reconcileNow() {
        if (closed) return;
        try {
            repository.reconcileExternalChanges("filesystem");
        } catch (IOException error) {
            Log.e(TAG, "Unable to reconcile external workspace change", error);
        }
        rebuildObservers();
    }

    private void rebuildObservers() {
        if (closed) return;
        Map<String, File> directories = new HashMap<>();
        collectDirectories(repository.rootDirectory(), directories);

        for (String path : new ArrayList<>(observers.keySet())) {
            if (directories.containsKey(path)) continue;
            observers.remove(path).stopWatching();
        }
        for (Map.Entry<String, File> entry : directories.entrySet()) {
            if (observers.containsKey(entry.getKey())) continue;
            FileObserver observer = new FileObserver(entry.getValue().getAbsolutePath(), EVENTS) {
                @Override
                public void onEvent(int event, String path) {
                    scheduleReconcile();
                }
            };
            observer.startWatching();
            observers.put(entry.getKey(), observer);
        }
    }

    private static void collectDirectories(File directory, Map<String, File> result) {
        if (directory == null || !directory.isDirectory()) return;
        try {
            File canonical = directory.getCanonicalFile();
            result.put(canonical.getPath(), canonical);
            File[] children = canonical.listFiles(File::isDirectory);
            if (children == null) return;
            for (File child : children) {
                // App-private workspaces should not contain links; canonical
                // equality keeps a malicious/imported link from being watched.
                if (!child.getAbsoluteFile().equals(child.getCanonicalFile())) continue;
                collectDirectories(child, result);
            }
        } catch (IOException error) {
            Log.w(TAG, "Skipping unreadable workspace directory", error);
        }
    }
}
