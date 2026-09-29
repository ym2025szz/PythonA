package com.pythona.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Resilient asynchronous Messenger client with timeout and binder-death errors. */
final class ServiceMessengerClient implements AutoCloseable {
    interface Callback {
        void onResponse(JSONObject response);
    }

    interface EventCallback {
        void onEvent(JSONObject event);
    }

    interface LifecycleCallback {
        void onState(String state, String message);
    }

    // First launch may atomically extract the bundled stdlib/Jedi tree before
    // answering. The Web broker can still apply a shorter per-request policy.
    private static final long DEFAULT_REQUEST_TIMEOUT_MILLIS = 60_000L;
    private static final long MIN_REQUEST_TIMEOUT_MILLIS = 1_000L;
    private static final long MAX_REQUEST_TIMEOUT_MILLIS = 10L * 60L * 1000L;
    private static final long STALE_SPOOL_AGE_MILLIS = 6L * 60L * 60L * 1000L;

    private static final class Pending {
        final JSONObject request;
        final Callback callback;
        final String requestJson;
        final long timeoutMillis;
        ScheduledFuture<?> timeout;
        IpcRequestSpool.Descriptor spool;

        Pending(JSONObject request, Callback callback) {
            this.request = request;
            this.callback = callback;
            this.requestJson = request.toString();
            this.timeoutMillis = requestTimeoutMillis(request);
        }
    }

    private final Context context;
    private final Intent serviceIntent;
    private final EventCallback eventCallback;
    private final LifecycleCallback lifecycleCallback;
    private final Object lock = new Object();
    private final Map<String, Pending> pendingById = new HashMap<>();
    private final Queue<Pending> sendQueue = new ArrayDeque<>();
    private final ScheduledExecutorService timeoutExecutor =
        Executors.newSingleThreadScheduledExecutor();
    private final HandlerThread replyThread;
    private final Messenger replyMessenger;
    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            boolean reconnected;
            synchronized (lock) {
                if (closed) return;
                reconnected = connectedOnce;
                connectedOnce = true;
                remote = new Messenger(binder);
                binding = false;
                while (!sendQueue.isEmpty()) sendNowLocked(sendQueue.remove());
            }
            notifyLifecycle(reconnected ? "reconnected" : "connected", name.toShortString());
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            // Android keeps this binding and will normally reconnect it. Fail
            // ambiguous in-flight calls, but queue future requests for that
            // reconnection instead of creating a duplicate binding.
            failAll("service-disconnected", "Host service disconnected", true);
            notifyLifecycle("disconnected", "Host service process disconnected");
        }

        @Override
        public void onBindingDied(ComponentName name) {
            discardDeadBinding();
            failAll("service-binding-died", "Host service binding died", false);
            notifyLifecycle("binding-died", "Host service binding died");
        }

        @Override
        public void onNullBinding(ComponentName name) {
            discardDeadBinding();
            failAll("service-null-binding", "Host service returned a null binding", false);
            notifyLifecycle("null-binding", "Host service returned a null binding");
        }
    };

    private Messenger remote;
    private boolean binding;
    private boolean bound;
    private boolean closed;
    private boolean connectedOnce;

    ServiceMessengerClient(Context context, Class<? extends BaseHostService> serviceClass) {
        this(context, serviceClass, null, null);
    }

    ServiceMessengerClient(
        Context context,
        Class<? extends BaseHostService> serviceClass,
        EventCallback eventCallback,
        LifecycleCallback lifecycleCallback
    ) {
        this.context = context.getApplicationContext();
        this.eventCallback = eventCallback;
        this.lifecycleCallback = lifecycleCallback;
        serviceIntent = new Intent(this.context, serviceClass);
        IpcRequestSpool.cleanupStale(
            this.context.getCacheDir(), STALE_SPOOL_AGE_MILLIS);
        replyThread = new HandlerThread(serviceClass.getSimpleName() + ".replies");
        replyThread.start();
        replyMessenger = new Messenger(new Handler(replyThread.getLooper(), this::handleReply));
    }

    void request(JSONObject request, Callback callback) {
        Pending pending = new Pending(request, callback);
        String id = request.optString("id", "");
        boolean credentialWrite = "dsh".equals(request.optString("channel", ""))
            && ("saveProfile".equals(request.optString("method", "")) || "configureCredential".equals(request.optString("method", "")))
            && request.optJSONObject("payload") != null
            && !request.optJSONObject("payload").optString("secret", "").isEmpty();
        if (credentialWrite && pending.requestJson.getBytes(StandardCharsets.UTF_8).length
            > IpcRequestSpool.INLINE_LIMIT_BYTES) {
            callback.onResponse(BridgeProtocol.error(
                request, "credential-spool-forbidden",
                "Credential writes must fit in an inline Binder envelope"));
            return;
        }
        try {
            pending.spool = IpcRequestSpool.writeIfNeeded(
                context.getCacheDir(),
                pending.requestJson,
                request.optString("id", ""),
                request.optString("channel", ""));
        } catch (Exception error) {
            callback.onResponse(BridgeProtocol.error(
                request, "request-spool-failed", message(error)));
            return;
        }
        synchronized (lock) {
            if (closed) {
                if (pending.spool != null) pending.spool.delete();
                callback.onResponse(BridgeProtocol.error(
                    request, "service-client-closed", "Host service client is closed"));
                return;
            }
            if (pendingById.containsKey(id)) {
                if (pending.spool != null) pending.spool.delete();
                callback.onResponse(BridgeProtocol.error(
                    request, "duplicate-request-id", "A request with this id is already pending"));
                return;
            }
            pendingById.put(id, pending);
            pending.timeout = timeoutExecutor.schedule(
                () -> timeout(id), pending.timeoutMillis, TimeUnit.MILLISECONDS);
            if (remote != null) {
                sendNowLocked(pending);
                return;
            }
            sendQueue.add(pending);
            bindLocked();
        }
    }

    @Override
    public void close() {
        ArrayList<Pending> abandoned;
        synchronized (lock) {
            if (closed) return;
            closed = true;
            abandoned = new ArrayList<>(pendingById.values());
            pendingById.clear();
            sendQueue.clear();
            remote = null;
            if (bound || binding) {
                try {
                    context.unbindService(connection);
                } catch (IllegalArgumentException ignored) {
                }
            }
            bound = false;
            binding = false;
        }
        for (Pending item : abandoned) {
            if (item.timeout != null) item.timeout.cancel(false);
            if (item.spool != null) item.spool.delete();
            item.callback.onResponse(BridgeProtocol.error(
                item.request, "service-client-closed", "Host service client was closed"));
        }
        timeoutExecutor.shutdownNow();
        replyThread.quitSafely();
    }

    private void bindLocked() {
        if (binding || bound || closed) return;
        binding = true;
        try {
            bound = context.bindService(serviceIntent, connection, Context.BIND_AUTO_CREATE);
        } catch (RuntimeException error) {
            binding = false;
            failAll("service-bind-failed", message(error), false);
            return;
        }
        if (!bound) {
            binding = false;
            failAll(
                "service-bind-failed", "Android refused the host service binding", false);
        }
    }

    private void sendNowLocked(Pending pending) {
        Message message = Message.obtain(null, BaseHostService.MESSAGE_REQUEST);
        Bundle data = new Bundle();
        if (pending.spool == null) {
            data.putString(BaseHostService.KEY_REQUEST_JSON, pending.requestJson);
        } else {
            pending.spool.writeTo(data);
        }
        message.setData(data);
        message.replyTo = replyMessenger;
        try {
            remote.send(message);
        } catch (RemoteException error) {
            completeLocked(pending.request.optString("id", ""), BridgeProtocol.error(
                pending.request, "service-send-failed", message(error)));
        }
    }

    private boolean handleReply(Message message) {
        if (message.what != BaseHostService.MESSAGE_RESPONSE
            && message.what != BaseHostService.MESSAGE_EVENT) return true;
        Bundle data = message.getData();
        IpcRequestSpool.Payload transported = null;
        JSONObject response;
        try {
            transported = IpcRequestSpool.readAndDelete(
                context.getCacheDir(), data, BaseHostService.KEY_RESPONSE_JSON);
            response = new JSONObject(transported.json);
            String responseChannel = response.optString("channel", "");
            if (transported.channel != null
                && !transported.channel.equals(responseChannel)) {
                throw new IllegalArgumentException(
                    "IPC spool channel does not match the enclosed response");
            }
            if (message.what == BaseHostService.MESSAGE_RESPONSE
                && transported.id != null
                && !transported.id.equals(response.optString("id", ""))) {
                throw new IllegalArgumentException(
                    "IPC spool id does not match the enclosed response");
            }
        } catch (Exception error) {
            handleInvalidReply(message.what, data, transported, error);
            return true;
        }
        if (message.what == BaseHostService.MESSAGE_EVENT) {
            if (eventCallback != null) eventCallback.onEvent(response);
            return true;
        }
        synchronized (lock) {
            completeLocked(response.optString("id", ""), response);
        }
        return true;
    }

    private void handleInvalidReply(
        int what,
        Bundle data,
        IpcRequestSpool.Payload transported,
        Exception error
    ) {
        String id = transported == null ? null : transported.id;
        String channel = transported == null ? null : transported.channel;
        if ((id == null || id.isEmpty()) && data != null) {
            id = data.getString(IpcRequestSpool.KEY_ID, "");
        }
        if ((channel == null || channel.isEmpty()) && data != null) {
            channel = data.getString(IpcRequestSpool.KEY_CHANNEL, "native");
        }
        String detail = message(error);
        if (what == BaseHostService.MESSAGE_EVENT) {
            if (eventCallback != null) {
                eventCallback.onEvent(BridgeProtocol.event(channel,
                    errorEvent("invalid-ipc-event", detail)));
            }
            return;
        }
        synchronized (lock) {
            Pending pending = pendingById.get(id);
            if (pending == null) return;
            completeLocked(id, BridgeProtocol.error(
                pending.request, "invalid-ipc-response", detail));
        }
    }

    private void timeout(String id) {
        synchronized (lock) {
            Pending pending = pendingById.get(id);
            if (pending == null) return;
            sendQueue.remove(pending);
            completeLocked(id, BridgeProtocol.error(
                pending.request, "service-timeout", "Host service did not respond in time"));
        }
    }

    private void completeLocked(String id, JSONObject response) {
        Pending pending = pendingById.remove(id);
        if (pending == null) return;
        sendQueue.remove(pending);
        if (pending.timeout != null) pending.timeout.cancel(false);
        if (pending.spool != null) {
            pending.spool.delete();
            pending.spool = null;
        }
        pending.callback.onResponse(response);
    }

    private void failAll(String code, String reason, boolean keepBinding) {
        ArrayList<Pending> failed;
        synchronized (lock) {
            remote = null;
            binding = false;
            if (!keepBinding) bound = false;
            failed = new ArrayList<>(pendingById.values());
            pendingById.clear();
            sendQueue.clear();
        }
        for (Pending item : failed) {
            if (item.timeout != null) item.timeout.cancel(false);
            if (item.spool != null) item.spool.delete();
            item.callback.onResponse(BridgeProtocol.error(item.request, code, reason));
        }
    }

    private void discardDeadBinding() {
        synchronized (lock) {
            if (!bound && !binding) return;
            try {
                context.unbindService(connection);
            } catch (IllegalArgumentException ignored) {
            }
            bound = false;
            binding = false;
            remote = null;
        }
    }

    private static String message(Exception error) {
        String value = error.getMessage();
        return value == null || value.isEmpty() ? error.getClass().getSimpleName() : value;
    }

    static long requestTimeoutMillis(JSONObject request) {
        long requested = request == null
            ? DEFAULT_REQUEST_TIMEOUT_MILLIS
            : request.optLong("transportTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MILLIS);
        return boundRequestTimeoutMillis(requested);
    }

    static long boundRequestTimeoutMillis(long requested) {
        if (requested < MIN_REQUEST_TIMEOUT_MILLIS) return MIN_REQUEST_TIMEOUT_MILLIS;
        return Math.min(requested, MAX_REQUEST_TIMEOUT_MILLIS);
    }

    private static JSONObject errorEvent(String code, String detail) {
        try {
            return new JSONObject()
                .put("type", "transport-error")
                .put("code", code)
                .put("message", detail);
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    private void notifyLifecycle(String state, String detail) {
        if (lifecycleCallback == null || closed) return;
        try {
            lifecycleCallback.onState(state, detail);
        } catch (RuntimeException ignored) {
            // UI lifecycle reporting must never destabilize Binder recovery.
        }
    }
}
