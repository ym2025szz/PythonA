package com.pythona.app;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Messenger endpoint used by isolated language/runtime processes. */
abstract class BaseHostService extends Service {
    static final int MESSAGE_REQUEST = 1;
    static final int MESSAGE_RESPONSE = 2;
    static final int MESSAGE_EVENT = 3;
    static final String KEY_REQUEST_JSON = "requestJson";
    static final String KEY_RESPONSE_JSON = "responseJson";
    private static final long STALE_SPOOL_AGE_MILLIS = 6L * 60L * 60L * 1000L;

    private HandlerThread workerThread;
    private ExecutorService requestExecutor;
    private Messenger messenger;
    private final Object clientsLock = new Object();
    private final Map<IBinder, Messenger> clients = new HashMap<>();

    @Override
    public void onCreate() {
        super.onCreate();
        IpcRequestSpool.cleanupStale(getCacheDir(), STALE_SPOOL_AGE_MILLIS);
        workerThread = new HandlerThread(getClass().getSimpleName() + ".ipc");
        workerThread.start();
        requestExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(
                runnable, getClass().getSimpleName() + ".requests");
            thread.setDaemon(true);
            return thread;
        });
        messenger = new Messenger(new Handler(workerThread.getLooper(), this::handleMessage));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return messenger.getBinder();
    }

    @Override
    public void onDestroy() {
        if (requestExecutor != null) requestExecutor.shutdownNow();
        if (workerThread != null) workerThread.quitSafely();
        synchronized (clientsLock) {
            clients.clear();
        }
        super.onDestroy();
    }

    protected abstract JSONObject handleRequest(
        String method,
        JSONObject payload,
        JSONObject request
    ) throws Exception;

    /**
     * Control requests must be short and thread-safe. They run on the IPC
     * looper so they can interrupt a long request running on the single
     * request worker (for example Jedi completion or Python execution).
     */
    protected boolean isConcurrentControlMethod(String method) {
        return false;
    }

    /** Broadcast one unsolicited protocol event to every connected broker. */
    protected final void emitEvent(String channel, JSONObject event) {
        JSONObject envelope = BridgeProtocol.event(channel, event);
        ArrayList<Map.Entry<IBinder, Messenger>> snapshot;
        synchronized (clientsLock) {
            snapshot = new ArrayList<>(clients.entrySet());
        }
        for (Map.Entry<IBinder, Messenger> client : snapshot) {
            if (!sendEnvelope(client.getValue(), MESSAGE_EVENT, envelope)) {
                synchronized (clientsLock) {
                    clients.remove(client.getKey());
                }
            }
        }
    }

    private boolean handleMessage(Message message) {
        if (message.what != MESSAGE_REQUEST || message.replyTo == null) return true;
        synchronized (clientsLock) {
            clients.put(message.replyTo.getBinder(), message.replyTo);
        }
        JSONObject request = null;
        try {
            Bundle data = message.getData();
            if (data != null && data.getString(IpcRequestSpool.KEY_ID) != null) {
                request = new JSONObject()
                    .put("protocolVersion", BridgeProtocol.VERSION)
                    .put("id", data.getString(IpcRequestSpool.KEY_ID, ""))
                    .put("channel", data.getString(IpcRequestSpool.KEY_CHANNEL, ""))
                    .put("method", "transport");
            }
            IpcRequestSpool.Payload transported = IpcRequestSpool.readAndDelete(
                getCacheDir(), data);
            request = BridgeProtocol.parseRequest(transported.json);
            if (transported.id != null
                && (!transported.id.equals(request.optString("id", ""))
                    || !transported.channel.equals(request.optString("channel", "")))) {
                throw new IllegalArgumentException(
                    "IPC spool identity does not match the enclosed request");
            }
            final JSONObject parsedRequest = request;
            final Messenger replyTo = message.replyTo;
            String method = parsedRequest.getString("method");
            if (isConcurrentControlMethod(method)) {
                executeRequest(parsedRequest, replyTo);
            } else {
                try {
                    requestExecutor.execute(() -> executeRequest(parsedRequest, replyTo));
                } catch (RejectedExecutionException stopping) {
                    sendResponse(replyTo, BridgeProtocol.error(
                        parsedRequest, "service-stopping", "Host service is stopping"));
                }
            }
        } catch (Throwable error) {
            sendResponse(message.replyTo, BridgeProtocol.error(
                request,
                "host-service-error",
                error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
        }
        return true;
    }

    private void executeRequest(JSONObject request, Messenger replyTo) {
        JSONObject response;
        try {
            JSONObject payload = request.optJSONObject("payload");
            if (payload == null) payload = new JSONObject();
            response = BridgeProtocol.success(
                request,
                handleRequest(request.getString("method"), payload, request));
        } catch (Throwable error) {
            response = BridgeProtocol.error(
                request,
                "host-service-error",
                error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
        sendResponse(replyTo, response);
    }

    private void sendResponse(Messenger replyTo, JSONObject response) {
        if (!sendEnvelope(replyTo, MESSAGE_RESPONSE, response)) {
            synchronized (clientsLock) {
                clients.remove(replyTo.getBinder());
            }
        }
    }

    /**
     * Keep Binder transactions bounded. The app and both host processes share
     * the same private cache directory, so a large envelope can be handed off
     * by authenticated descriptor without granting broad filesystem access.
     */
    private boolean sendEnvelope(Messenger replyTo, int what, JSONObject envelope) {
        Message reply = Message.obtain(null, what);
        Bundle result = new Bundle();
        IpcRequestSpool.Descriptor spool = null;
        try {
            String channel = envelope.optString("channel", "native");
            String id = envelope.optString("id", "");
            if (id.isEmpty()) id = "event";
            spool = IpcRequestSpool.writeIfNeeded(
                getCacheDir(), envelope.toString(), id, channel);
            if (spool == null) {
                result.putString(KEY_RESPONSE_JSON, envelope.toString());
            } else {
                spool.writeTo(result);
            }
        } catch (IOException overflowFailure) {
            // Never retry the original large JSON inline: that would recreate
            // the TransactionTooLargeException this path exists to prevent.
            JSONObject fallback = transportFailure(envelope, what, overflowFailure);
            result.putString(KEY_RESPONSE_JSON, fallback.toString());
        }
        reply.setData(result);
        try {
            replyTo.send(reply);
            return true;
        } catch (RemoteException deadClient) {
            if (spool != null) spool.delete();
            return false;
        }
    }

    private static JSONObject transportFailure(
        JSONObject original,
        int what,
        Throwable error
    ) {
        try {
            if (what == MESSAGE_EVENT) {
                return BridgeProtocol.event(original.optString("channel", "native"),
                    new JSONObject()
                        .put("type", "transport-error")
                        .put("code", "response-spool-failed")
                        .put("message", safeMessage(error)));
            }
            JSONObject requestIdentity = new JSONObject()
                .put("id", original.optString("id", ""))
                .put("channel", original.optString("channel", "native"))
                .put("method", original.optString("method", "transport"));
            return BridgeProtocol.error(
                requestIdentity, "response-spool-failed", safeMessage(error));
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    private static String safeMessage(Throwable error) {
        String value = error == null ? null : error.getMessage();
        return value == null || value.isEmpty()
            ? (error == null ? "IPC overflow transport failed" : error.getClass().getSimpleName())
            : value;
    }
}
