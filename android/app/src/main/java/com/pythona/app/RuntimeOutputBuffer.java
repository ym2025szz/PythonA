package com.pythona.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Bounded, ordered coalescing for the embedded runtime's console stream.
 *
 * <p>CPython may call {@code write()} once per character or token. Sending one
 * Messenger event for every callback can overwhelm Binder and the WebView even
 * when every individual transaction is small. This buffer combines adjacent
 * writes for the same run and stream for one short display frame. It applies
 * synchronous backpressure at {@link #MAX_PENDING_TEXT_CHARS}, so a producer
 * cannot create an unbounded Java-side output queue.</p>
 *
 * <p>All sink calls happen while the ordering lock is held. Consequently a
 * {@link #flushThen(Runnable)} terminal/control event is emitted only after all
 * output accepted before it, even when a timed flush is already in progress.</p>
 */
final class RuntimeOutputBuffer implements AutoCloseable {
    interface Sink {
        void emit(String runId, String stream, String text);
    }

    /**
     * Text is capped before JSON encoding. Even the worst-case JSON escaping
     * (six ASCII bytes per UTF-16 code unit) stays comfortably below Binder's
     * transaction ceiling; BaseHostService independently spools large envelopes.
     */
    static final int MAX_EVENT_TEXT_CHARS = 8 * 1024;
    static final int MAX_PENDING_TEXT_CHARS = 4 * MAX_EVENT_TEXT_CHARS;
    static final long DEFAULT_FLUSH_DELAY_MILLIS = 32L;

    private static final class Segment {
        final String runId;
        final String stream;
        final StringBuilder text = new StringBuilder();

        Segment(String runId, String stream) {
            this.runId = runId;
            this.stream = stream;
        }
    }

    private final Object lock = new Object();
    private final Sink sink;
    private final long flushDelayMillis;
    private final ScheduledExecutorService scheduler;
    private final ArrayList<Segment> pending = new ArrayList<>();

    private ScheduledFuture<?> scheduledFlush;
    private int pendingTextChars;
    private boolean closed;

    RuntimeOutputBuffer(Sink sink) {
        this(sink, DEFAULT_FLUSH_DELAY_MILLIS);
    }

    /** Visible for deterministic JVM tests that explicitly call {@link #flush()}. */
    RuntimeOutputBuffer(Sink sink, long flushDelayMillis) {
        this.sink = Objects.requireNonNull(sink, "sink");
        if (flushDelayMillis < 0L) {
            throw new IllegalArgumentException("flushDelayMillis must be non-negative");
        }
        this.flushDelayMillis = flushDelayMillis;
        scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "PythonA.runtime.output");
            thread.setDaemon(true);
            return thread;
        });
    }

    void append(String runId, String stream, String text) {
        if (text == null || text.isEmpty()) return;
        String safeStream = "stderr".equals(stream) ? "stderr" : "stdout";
        synchronized (lock) {
            if (closed) return;
            int offset = 0;
            while (offset < text.length()) {
                Segment target = lastCompatibleSegment(runId, safeStream);
                int capacity = target == null
                    ? MAX_EVENT_TEXT_CHARS
                    : MAX_EVENT_TEXT_CHARS - target.text.length();
                int end = Math.min(text.length(), offset + capacity);

                // Never split a valid surrogate pair between protocol events.
                if (end < text.length()
                    && end > offset
                    && Character.isHighSurrogate(text.charAt(end - 1))
                    && Character.isLowSurrogate(text.charAt(end))) {
                    end -= 1;
                }
                // A nearly-full previous segment may have only one UTF-16 code
                // unit left while the next code point needs a surrogate pair.
                if (end == offset) {
                    target = new Segment(runId, safeStream);
                    pending.add(target);
                    capacity = MAX_EVENT_TEXT_CHARS;
                    end = Math.min(text.length(), offset + capacity);
                    if (end < text.length()
                        && Character.isHighSurrogate(text.charAt(end - 1))
                        && Character.isLowSurrogate(text.charAt(end))) {
                        end -= 1;
                    }
                } else if (target == null) {
                    target = new Segment(runId, safeStream);
                    pending.add(target);
                }

                target.text.append(text, offset, end);
                pendingTextChars += end - offset;
                offset = end;

                if (pendingTextChars >= MAX_PENDING_TEXT_CHARS) {
                    cancelScheduledFlushLocked();
                    flushLocked();
                }
            }
            if (!pending.isEmpty()) scheduleFlushLocked();
        }
    }

    /** Drain pending output immediately, preserving run/stream transition order. */
    void flush() {
        synchronized (lock) {
            cancelScheduledFlushLocked();
            flushLocked();
        }
    }

    /**
     * Emit a control or terminal event after all previously accepted output.
     * The action shares the same lock with timed flushes, making the ordering a
     * property of this class rather than a timing assumption in the service.
     */
    void flushThen(Runnable action) {
        Objects.requireNonNull(action, "action");
        synchronized (lock) {
            cancelScheduledFlushLocked();
            flushLocked();
            action.run();
        }
    }

    @Override
    public void close() {
        synchronized (lock) {
            if (closed) return;
            closed = true;
            cancelScheduledFlushLocked();
            flushLocked();
        }
        scheduler.shutdownNow();
    }

    private Segment lastCompatibleSegment(String runId, String stream) {
        if (pending.isEmpty()) return null;
        Segment last = pending.get(pending.size() - 1);
        if (!Objects.equals(last.runId, runId)
            || !last.stream.equals(stream)
            || last.text.length() >= MAX_EVENT_TEXT_CHARS) {
            return null;
        }
        return last;
    }

    private void scheduleFlushLocked() {
        if (scheduledFlush != null || closed) return;
        try {
            scheduledFlush = scheduler.schedule(() -> {
                synchronized (lock) {
                    scheduledFlush = null;
                    flushLocked();
                }
            }, flushDelayMillis, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException stopping) {
            // Do not strand output if shutdown races the scheduling edge.
            flushLocked();
        }
    }

    private void cancelScheduledFlushLocked() {
        if (scheduledFlush == null) return;
        scheduledFlush.cancel(false);
        scheduledFlush = null;
    }

    private void flushLocked() {
        if (pending.isEmpty()) return;
        List<Segment> snapshot = new ArrayList<>(pending);
        pending.clear();
        pendingTextChars = 0;
        for (Segment segment : snapshot) {
            try {
                sink.emit(segment.runId, segment.stream, segment.text.toString());
            } catch (RuntimeException ignored) {
                // A dead UI client must not terminate the embedded interpreter
                // or prevent the later finished event from being attempted.
            }
        }
    }
}
