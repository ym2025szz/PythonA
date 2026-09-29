package com.pythona.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES-GCM credential vault available only to the :dsh host service. */
final class DshCredentialStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String MASTER_ALIAS = "pythona.dsh.credentials.v1";
    private static final int FILE_MAGIC = 0x5059414b; // PYAK
    private static final Pattern SAFE_REF = Pattern.compile("key-[A-Za-z0-9-]{8,80}");
    private static final int MAX_SECRET_BYTES = 64 * 1024;

    private final File root;
    private final SecureRandom random = new SecureRandom();

    DshCredentialStore(Context context) throws Exception {
        if (context == null) throw new IllegalArgumentException("Context is required");
        root = new File(context.getNoBackupFilesDir(), "dsh-credentials").getCanonicalFile();
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Unable to create the DSH credential vault");
        }
        masterKey();
    }

    synchronized String put(String currentRef, String secret) throws Exception {
        byte[] plain = String.valueOf(secret == null ? "" : secret)
            .getBytes(StandardCharsets.UTF_8);
        if (plain.length == 0) return currentRef == null ? "" : currentRef;
        if (plain.length > MAX_SECRET_BYTES) throw new IllegalArgumentException("API key is too large");
        // Rotate the reference for every replacement. Reusing the same file
        // with an atomic rename would unlink the previous ciphertext without
        // giving delete() a chance to overwrite it first.
        String keyRef = "key-" + UUID.randomUUID();
        DshCredentialCipher.Envelope envelope;
        try {
            envelope = DshCredentialCipher.encrypt(masterKey(), keyRef, plain);
        } finally {
            java.util.Arrays.fill(plain, (byte) 0);
        }
        byte[] iv = envelope.iv;
        byte[] encrypted = envelope.ciphertext;
        File target = file(keyRef);
        File temporary = new File(root, keyRef + ".tmp-" + UUID.randomUUID());
        try {
            try (FileOutputStream fileOutput = new FileOutputStream(temporary);
                 DataOutputStream output = new DataOutputStream(
                     new BufferedOutputStream(fileOutput))) {
                output.writeInt(FILE_MAGIC);
                output.writeInt(iv.length);
                output.write(iv);
                output.writeInt(encrypted.length);
                output.write(encrypted);
                output.flush();
                fileOutput.getFD().sync();
            }
            Files.move(temporary.toPath(), target.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            java.util.Arrays.fill(encrypted, (byte) 0);
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
        return keyRef;
    }

    synchronized char[] get(String keyRef) throws Exception {
        if (!isSafeRef(keyRef)) throw new IllegalArgumentException("Invalid credential reference");
        File source = file(keyRef);
        if (!source.isFile()) throw new IOException("Credential is unavailable");
        byte[] iv;
        byte[] encrypted;
        try (DataInputStream input = new DataInputStream(
            new BufferedInputStream(new FileInputStream(source)))) {
            if (input.readInt() != FILE_MAGIC) throw new IOException("Unsupported credential file");
            int ivLength = input.readInt();
            if (ivLength != 12) throw new IOException("Invalid credential nonce");
            iv = new byte[ivLength];
            input.readFully(iv);
            int encryptedLength = input.readInt();
            if (encryptedLength < 16 || encryptedLength > MAX_SECRET_BYTES + 32) {
                throw new IOException("Invalid credential ciphertext");
            }
            encrypted = new byte[encryptedLength];
            input.readFully(encrypted);
            if (input.read() != -1) throw new IOException("Credential file has trailing bytes");
        }
        byte[] plain;
        try {
            plain = DshCredentialCipher.decrypt(masterKey(), keyRef, iv, encrypted);
        } finally {
            java.util.Arrays.fill(encrypted, (byte) 0);
        }
        try {
            return new String(plain, StandardCharsets.UTF_8).toCharArray();
        } finally {
            java.util.Arrays.fill(plain, (byte) 0);
        }
    }

    synchronized boolean contains(String keyRef) {
        try { return isSafeRef(keyRef) && file(keyRef).isFile(); }
        catch (IOException error) { return false; }
    }

    synchronized void delete(String keyRef) throws IOException {
        if (!isSafeRef(keyRef)) return;
        File target = file(keyRef);
        if (!target.isFile()) return;
        // Flash filesystems cannot promise physical overwrite, but replacing
        // the app-private ciphertext before unlinking avoids retaining the old
        // bytes in ordinary filesystem reads and backups are disabled.
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            byte[] randomBytes = new byte[(int) Math.min(target.length(), 128 * 1024)];
            random.nextBytes(randomBytes);
            output.write(randomBytes);
            output.flush();
            output.getFD().sync();
            java.util.Arrays.fill(randomBytes, (byte) 0);
        }
        Files.deleteIfExists(target.toPath());
    }

    /** Best-effort cleanup for ciphertext no longer referenced by a profile. */
    synchronized void deleteUnreferenced(java.util.Set<String> referenced) {
        File[] files = root.listFiles((directory, name) ->
            name.startsWith("key-") && name.endsWith(".bin"));
        if (files == null) return;
        for (File candidate : files) {
            String name = candidate.getName();
            String keyRef = name.substring(0, name.length() - 4);
            if (referenced != null && referenced.contains(keyRef)) continue;
            try { delete(keyRef); } catch (IOException ignored) { /* retry next start */ }
        }
    }

    private SecretKey masterKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(MASTER_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            MASTER_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private File file(String keyRef) throws IOException {
        File result = new File(root, keyRef + ".bin").getCanonicalFile();
        if (!result.getParentFile().equals(root)) throw new IOException("Unsafe credential path");
        return result;
    }

    private static boolean isSafeRef(String keyRef) {
        return keyRef != null && SAFE_REF.matcher(keyRef).matches();
    }
}
