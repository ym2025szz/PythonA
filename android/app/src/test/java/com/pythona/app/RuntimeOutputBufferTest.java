package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

public final class RuntimeOutputBufferTest {
    private static final long MANUAL_FLUSH_DELAY_MILLIS = 60_000L;

    private static final class Event {
        final String runId;
        final String stream;
        final String text;

        Event(String runId, String stream, String text) {
            this.runId = runId;
            this.stream = stream;
            this.text = text;
        }
    }

    @Test
    public void coalescesAdjacentWritesWithoutReorderingStreamTransitions() {
        ArrayList<Event> events = new ArrayList<>();
        RuntimeOutputBuffer buffer = new RuntimeOutputBuffer(
            (runId, stream, text) -> events.add(new Event(runId, stream, text)),
            MANUAL_FLUSH_DELAY_MILLIS);
        try {
            buffer.append("run-1", "stdout", "a");
            buffer.append("run-1", "stdout", "b");
            buffer.append("run-1", "stderr", "c");
            buffer.append("run-1", "stderr", "d");
            buffer.append("run-1", "stdout", "e");
            buffer.append("run-2", "stdout", "f");
            buffer.flush();

            assertEquals(4, events.size());
            assertEvent(events.get(0), "run-1", "stdout", "ab");
            assertEvent(events.get(1), "run-1", "stderr", "cd");
            assertEvent(events.get(2), "run-1", "stdout", "e");
            assertEvent(events.get(3), "run-2", "stdout", "f");
        } finally {
            buffer.close();
        }
    }

    @Test
    public void boundsEveryEventAndPreservesUnicodeExactly() {
        ArrayList<Event> events = new ArrayList<>();
        RuntimeOutputBuffer buffer = new RuntimeOutputBuffer(
            (runId, stream, text) -> events.add(new Event(runId, stream, text)),
            MANUAL_FLUSH_DELAY_MILLIS);
        String source = "x".repeat(RuntimeOutputBuffer.MAX_EVENT_TEXT_CHARS - 1)
            + "\uD83D\uDE80"
            + "汉".repeat(RuntimeOutputBuffer.MAX_PENDING_TEXT_CHARS);
        try {
            buffer.append("run-unicode", "stdout", source);

            // Crossing the pending hard cap drains synchronously and therefore
            // backpressures the producer instead of growing an unbounded queue.
            assertFalse(events.isEmpty());
            buffer.flush();

            StringBuilder reconstructed = new StringBuilder();
            for (Event event : events) {
                assertTrue(event.text.length() <= RuntimeOutputBuffer.MAX_EVENT_TEXT_CHARS);
                assertFalse(endsWithUnpairedHighSurrogate(event.text));
                assertFalse(startsWithUnpairedLowSurrogate(event.text));
                reconstructed.append(event.text);
            }
            assertEquals(source, reconstructed.toString());
        } finally {
            buffer.close();
        }
    }

    @Test
    public void terminalActionRunsAfterAllAcceptedOutput() {
        ArrayList<String> order = new ArrayList<>();
        RuntimeOutputBuffer buffer = new RuntimeOutputBuffer(
            (runId, stream, text) -> order.add(stream + ":" + text),
            MANUAL_FLUSH_DELAY_MILLIS);
        try {
            buffer.append("run-1", "stdout", "before");
            buffer.append("run-1", "stderr", "error");
            buffer.flushThen(() -> order.add("finished"));

            assertEquals(List.of("stdout:before", "stderr:error", "finished"), order);
        } finally {
            buffer.close();
        }
    }

    @Test
    public void failedOutputDeliveryCannotSuppressTerminalAction() {
        AtomicInteger attempts = new AtomicInteger();
        AtomicBoolean terminal = new AtomicBoolean();
        RuntimeOutputBuffer buffer = new RuntimeOutputBuffer((runId, stream, text) -> {
            attempts.incrementAndGet();
            throw new IllegalStateException("dead client");
        }, MANUAL_FLUSH_DELAY_MILLIS);
        try {
            buffer.append("run-1", "stdout", "output");
            buffer.flushThen(() -> terminal.set(true));

            assertEquals(1, attempts.get());
            assertTrue(terminal.get());
        } finally {
            buffer.close();
        }
    }

    private static void assertEvent(
        Event event,
        String runId,
        String stream,
        String text
    ) {
        assertEquals(runId, event.runId);
        assertEquals(stream, event.stream);
        assertEquals(text, event.text);
    }

    private static boolean endsWithUnpairedHighSurrogate(String value) {
        return !value.isEmpty() && Character.isHighSurrogate(value.charAt(value.length() - 1));
    }

    private static boolean startsWithUnpairedLowSurrogate(String value) {
        return !value.isEmpty() && Character.isLowSurrogate(value.charAt(0));
    }
}
