package com.pythona.app;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Envelope encryption shared by the Keystore vault and JVM regression tests. */
final class DshCredentialCipher {
    static final class Envelope {
        final byte[] iv, ciphertext;
        Envelope(byte[] iv, byte[] ciphertext) { this.iv = iv; this.ciphertext = ciphertext; }
    }
    static Envelope encrypt(SecretKey key, String reference, byte[] plain) throws GeneralSecurityException {
        return encrypt(Cipher.getInstance("AES/GCM/NoPadding"), key, reference, plain);
    }
    static Envelope encrypt(Cipher cipher, SecretKey key, String reference, byte[] plain) throws GeneralSecurityException {
        try {
            // Android Keystore enforces randomized encryption: it owns nonce
            // generation. Supplying GCMParameterSpec here is explicitly forbidden.
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != 12) throw new GeneralSecurityException("Invalid generated credential nonce");
            cipher.updateAAD(reference.getBytes(StandardCharsets.UTF_8));
            return new Envelope(iv, cipher.doFinal(plain));
        } finally { Arrays.fill(plain, (byte) 0); }
    }
    static byte[] decrypt(SecretKey key, String reference, byte[] iv, byte[] ciphertext) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        cipher.updateAAD(reference.getBytes(StandardCharsets.UTF_8));
        return cipher.doFinal(ciphertext);
    }
}
