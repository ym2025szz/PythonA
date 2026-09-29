package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;

import org.junit.Test;

public final class IpcRequestSpoolTest {
    @Test
    public void keepsSmallRequestsInline() throws Exception {
        File cache = Files.createTempDirectory("pythona-ipc-small").toFile();
        try {
            assertNull(IpcRequestSpool.writeIfNeeded(
                cache, "{\"small\":true}", "request-1", "language"));
            assertFalse(new File(cache, "ipc-spool").exists());
        } finally {
            deleteTree(cache);
        }
    }

    @Test
    public void atomicallySpoolsLargeUtf8RequestsAndCanCleanThem() throws Exception {
        File cache = Files.createTempDirectory("pythona-ipc-large").toFile();
        try {
            StringBuilder json = new StringBuilder("{\"text\":\"");
            while (json.length() < IpcRequestSpool.INLINE_LIMIT_BYTES + 1024) {
                json.append("代码🙂");
            }
            json.append("\"}");
            IpcRequestSpool.Descriptor descriptor = IpcRequestSpool.writeIfNeeded(
                cache, json.toString(), "request-2", "language");
            assertTrue(descriptor.file.isFile());
            assertTrue(descriptor.size > IpcRequestSpool.INLINE_LIMIT_BYTES);
            assertEquals(64, descriptor.sha256.length());
            assertEquals("request-2", descriptor.id);
            assertEquals("language", descriptor.channel);
            assertEquals(descriptor.size, descriptor.file.length());
            descriptor.delete();
            assertFalse(descriptor.file.exists());
        } finally {
            deleteTree(cache);
        }
    }

    private static void deleteTree(File file) throws Exception {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        Files.deleteIfExists(file.toPath());
    }
}
