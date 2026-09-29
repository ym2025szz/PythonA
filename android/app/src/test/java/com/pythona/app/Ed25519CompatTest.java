package com.pythona.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** RFC 8032 verification vectors for the API-30-compatible pack verifier. */
public final class Ed25519CompatTest {
    @Test
    public void verifiesRfc8032EmptyMessageVector() {
        byte[] publicKey = hex(
            "d75a980182b10ab7d54bfed3c964073a"
                + "0ee172f3daa62325af021a68f707511a");
        byte[] signature = hex(
            "e5564300c360ac729086e2cc806e828a"
                + "84877f1eb8e5d974d873e06522490155"
                + "5fb8821590a33bacc61e39701cf9b46b"
                + "d25bf5f0595bbe24655141438e7a100b");

        assertTrue(RuntimePackManager.verifyEd25519(publicKey, new byte[0], signature));
    }

    @Test
    public void rejectsTamperedSignatureAndInvalidLengths() {
        byte[] publicKey = hex(
            "d75a980182b10ab7d54bfed3c964073a"
                + "0ee172f3daa62325af021a68f707511a");
        byte[] signature = hex(
            "e5564300c360ac729086e2cc806e828a"
                + "84877f1eb8e5d974d873e06522490155"
                + "5fb8821590a33bacc61e39701cf9b46b"
                + "d25bf5f0595bbe24655141438e7a100b");
        signature[7] ^= 0x01;

        assertFalse(RuntimePackManager.verifyEd25519(publicKey, new byte[0], signature));
        assertFalse(RuntimePackManager.verifyEd25519(new byte[31], new byte[0], new byte[64]));
        assertFalse(RuntimePackManager.verifyEd25519(publicKey, new byte[0], new byte[63]));
    }

    private static byte[] hex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int index = 0; index < result.length; index += 1) {
            result[index] = (byte) Integer.parseInt(
                value.substring(index * 2, index * 2 + 2), 16);
        }
        return result;
    }
}
