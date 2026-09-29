package com.pythona.app;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.*;
import org.json.JSONObject;
import org.junit.Test;

public final class DshInlineHttpTest {
    /** A bounded loopback fixture using only the Android-visible java.net API. */
    private static final class Fixture implements AutoCloseable {
        final AtomicInteger calls = new AtomicInteger();
        final AtomicReference<String> body = new AtomicReference<>();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final ServerSocket server;
        final Thread worker;
        volatile Socket connection;
        volatile boolean closed;

        Fixture(int status, String content) throws IOException {
            server = new ServerSocket(0, 4, InetAddress.getByAddress(new byte[]{127, 0, 0, 1}));
            worker = new Thread(() -> {
                try {
                    while (!closed && calls.get() < 4) {
                        try (Socket accepted = server.accept()) {
                            connection = accepted;
                            accepted.setSoTimeout(3000);
                            InputStream input = accepted.getInputStream();
                            String requestLine = line(input);
                            if (!"POST /v1/chat/completions HTTP/1.1".equals(requestLine)) throw new IOException("Unexpected request target");
                            int length = -1;
                            boolean complete = false;
                            for (int count = 0; count < 64; count++) {
                                String header = line(input);
                                if (header.isEmpty()) { complete = true; break; }
                                if (header.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:"))
                                    length = Integer.parseInt(header.substring(header.indexOf(':') + 1).trim());
                            }
                            if (!complete || length < 0 || length > 64 * 1024) throw new IOException("Unbounded request body");
                            byte[] request = new byte[length];
                            int offset = 0;
                            while (offset < length) {
                                int read = input.read(request, offset, length - offset);
                                if (read < 0) throw new IOException("Incomplete request body");
                                offset += read;
                            }
                            body.set(new String(request, StandardCharsets.UTF_8));
                            calls.incrementAndGet();
                            byte[] response = content.getBytes(StandardCharsets.UTF_8);
                            OutputStream output = accepted.getOutputStream();
                            output.write(("HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\n"
                                + "Content-Type: text/event-stream\r\nContent-Length: " + response.length
                                + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                            output.write(response); output.flush();
                        } finally { connection = null; }
                    }
                } catch (Throwable error) { if (!closed) failure.set(error); }
            }, "pythona-inline-http-fixture");
            worker.setDaemon(true); worker.start();
        }
        private static String line(InputStream input) throws IOException {
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            for (int count = 0; count < 8192; count++) {
                int next = input.read();
                if (next < 0) throw new IOException("Incomplete HTTP headers");
                if (next == '\n') return result.toString(StandardCharsets.US_ASCII.name()).replace("\r", "");
                result.write(next);
            }
            throw new IOException("HTTP header too large");
        }
        int port() { return server.getLocalPort(); }
        @Override public void close() throws Exception {
            closed = true; server.close();
            Socket pending = connection; if (pending != null) pending.close();
            worker.join(4000);
            assertFalse("HTTP fixture must stop", worker.isAlive());
            if (failure.get() != null) throw new AssertionError("HTTP fixture failed", failure.get());
        }
    }
    private JSONObject profile(int port) throws Exception {
        return new JSONObject().put("providerKind", DshProviderRegistry.OPENAI_COMPATIBLE)
            .put("baseUrl", "http://127.0.0.1:" + port + "/v1").put("allowLocalEndpoint", true)
            .put("model", "test").put("supportsTools", true).put("maxOutputTokens", 10000);
    }
    @Test public void cancellationBeforeAdmissionDoesNotSendALateHttpRequest() throws Exception {
        char[] secret = "unit-fixture".toCharArray();
        try (Fixture server = new Fixture(500, "")) {
            DshHttpClient client = new DshHttpClient(); client.cancelInline("cancel-before-start");
            assertThrows(Exception.class, () -> client.inlineComplete("cancel-before-start", profile(server.port()), secret,
                new JSONObject().put("prefix", "x=").put("suffix", "")));
            assertEquals(0, server.calls.get()); for (char value : secret) assertEquals('\0', value);
        }
    }
    @Test public void compatibilityInlineIsSingleAttemptAndClearsKeyOnFailure() throws Exception {
        char[] secret = "unit-fixture".toCharArray();
        try (Fixture server = new Fixture(500, "")) {
            assertThrows(Exception.class, () -> new DshHttpClient().inlineComplete("test", profile(server.port()), secret,
                new JSONObject().put("prefix", "x=").put("suffix", "")));
            assertEquals(1, server.calls.get()); for (char value : secret) assertEquals('\0', value);
            assertEquals(1, DshHttpClient.StreamOptions.inline().attempts);
            assertEquals(30000, DshHttpClient.StreamOptions.inline().readTimeout);
        }
    }
    @Test public void compatibilityInlineHasOwnPromptCapAndNoToolSchemas() throws Exception {
        try (Fixture server = new Fixture(200, "data: {\"choices\":[{\"delta\":{\"content\":\"42\"}}]}\n\ndata: [DONE]\n\n")) {
            JSONObject result = new DshHttpClient().inlineComplete("test", profile(server.port()), "fixture".toCharArray(),
                new JSONObject().put("prefix", "x=").put("suffix", "").put("history", "not-sent").put("tools", "not-sent"));
            assertEquals("42", result.getString("text")); JSONObject sent = new JSONObject(server.body.get());
            assertEquals(256, sent.getInt("max_tokens")); assertFalse(sent.has("tools")); assertFalse(server.body.get().contains("not-sent"));
            assertTrue(sent.getJSONArray("messages").getJSONObject(0).getString("content").contains("code exactly at the cursor"));
        }
    }
}
