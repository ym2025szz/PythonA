package com.pythona.app;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.InvalidAlgorithmParameterException;
import java.security.InvalidKeyException;
import java.security.Key;
import java.security.Provider;
import java.security.SecureRandom;
import java.security.spec.AlgorithmParameterSpec;
import java.util.Arrays;
import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.CipherSpi;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.ShortBufferException;
import org.junit.Test;

public final class DshCredentialCipherTest {
    private static SecretKey key() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        return generator.generateKey();
    }

    private static byte[] fixture() {
        return "test-only-provider-credential".getBytes(StandardCharsets.UTF_8);
    }

    private static void assertWiped(byte[] bytes) {
        assertArrayEquals(new byte[bytes.length], bytes);
    }

    @Test public void roundTripUsesGeneratedNonceAndWipesPlaintext() throws Exception {
        SecretKey key = key();
        byte[] plain = fixture();
        DshCredentialCipher.Envelope encrypted = DshCredentialCipher.encrypt(key, "key-fixture", plain);
        assertEquals(12, encrypted.iv.length);
        assertFalse(Arrays.equals(fixture(), encrypted.ciphertext));
        assertArrayEquals(fixture(), DshCredentialCipher.decrypt(
            key, "key-fixture", encrypted.iv, encrypted.ciphertext));
        assertWiped(plain);
    }

    @Test public void replacementGeneratesFreshNonceForTheSameKeyAndReference() throws Exception {
        SecretKey key = key();
        DshCredentialCipher.Envelope first = DshCredentialCipher.encrypt(key, "key-fixture", fixture());
        DshCredentialCipher.Envelope second = DshCredentialCipher.encrypt(key, "key-fixture", fixture());
        assertEquals(12, first.iv.length);
        assertEquals(12, second.iv.length);
        assertFalse(Arrays.equals(first.iv, second.iv));
        assertFalse(Arrays.equals(first.ciphertext, second.ciphertext));
    }

    @Test public void credentialCannotBeReassignedToAnotherReference() throws Exception {
        SecretKey key = key();
        DshCredentialCipher.Envelope encrypted = DshCredentialCipher.encrypt(key, "key-original", fixture());
        assertThrows(AEADBadTagException.class, () -> DshCredentialCipher.decrypt(
            key, "key-replacement", encrypted.iv, encrypted.ciphertext));
    }

    @Test public void tamperedCiphertextOrNonceIsRejected() throws Exception {
        SecretKey key = key();
        DshCredentialCipher.Envelope encrypted = DshCredentialCipher.encrypt(key, "key-fixture", fixture());
        byte[] tamperedCiphertext = encrypted.ciphertext.clone();
        tamperedCiphertext[0] ^= 1;
        assertThrows(AEADBadTagException.class, () -> DshCredentialCipher.decrypt(
            key, "key-fixture", encrypted.iv, tamperedCiphertext));
        byte[] tamperedIv = encrypted.iv.clone();
        tamperedIv[0] ^= 1;
        assertThrows(AEADBadTagException.class, () -> DshCredentialCipher.decrypt(
            key, "key-fixture", tamperedIv, encrypted.ciphertext));
    }

    @Test public void androidRandomizedEncryptionPolicyReceivesNoCallerProvidedIv() throws Exception {
        SecretKey key = key();
        RandomizedEncryptionSpi spi = new RandomizedEncryptionSpi(false, false);
        byte[] plain = fixture();
        DshCredentialCipher.Envelope encrypted = DshCredentialCipher.encrypt(
            testCipher(spi), key, "key-fixture", plain);
        assertEquals(1, spi.keyOnlyInitializations);
        assertEquals(0, spi.parameterInitializations);
        assertArrayEquals(fixture(), DshCredentialCipher.decrypt(
            key, "key-fixture", encrypted.iv, encrypted.ciphertext));
        assertWiped(plain);
    }

    @Test public void failedKeyInitializationStillWipesPlaintext() throws Exception {
        byte[] plain = fixture();
        Cipher cipher = testCipher(new RandomizedEncryptionSpi(true, false));
        SecretKey key = key();
        assertThrows(InvalidKeyException.class, () -> DshCredentialCipher.encrypt(
            cipher, key, "key-fixture", plain));
        assertWiped(plain);
    }

    @Test public void invalidGeneratedNonceStillWipesPlaintext() throws Exception {
        byte[] plain = fixture();
        Cipher cipher = testCipher(new RandomizedEncryptionSpi(false, true));
        SecretKey key = key();
        assertThrows(GeneralSecurityException.class, () -> DshCredentialCipher.encrypt(
            cipher, key, "key-fixture", plain));
        assertWiped(plain);
    }

    /** Models Android Keystore's randomizedEncryptionRequired policy. */
    private static final class RandomizedEncryptionSpi extends CipherSpi {
        private final Cipher delegate;
        private final boolean rejectKey, invalidNonce;
        int keyOnlyInitializations, parameterInitializations;

        RandomizedEncryptionSpi(boolean rejectKey, boolean invalidNonce) throws Exception {
            delegate = Cipher.getInstance("AES/GCM/NoPadding");
            this.rejectKey = rejectKey;
            this.invalidNonce = invalidNonce;
        }

        @Override protected void engineInit(int mode, Key key, SecureRandom random) throws InvalidKeyException {
            keyOnlyInitializations++;
            if (rejectKey) throw new InvalidKeyException("Fixture initialization failure");
            delegate.init(mode, key, random);
        }
        @Override protected void engineInit(int mode, Key key, AlgorithmParameterSpec parameters, SecureRandom random)
            throws InvalidAlgorithmParameterException {
            parameterInitializations++;
            throw new InvalidAlgorithmParameterException("Caller-provided IV not permitted");
        }
        @Override protected void engineInit(int mode, Key key, AlgorithmParameters parameters, SecureRandom random)
            throws InvalidAlgorithmParameterException {
            parameterInitializations++;
            throw new InvalidAlgorithmParameterException("Caller-provided IV not permitted");
        }
        @Override protected void engineSetMode(String mode) { }
        @Override protected void engineSetPadding(String padding) { }
        @Override protected int engineGetBlockSize() { return delegate.getBlockSize(); }
        @Override protected int engineGetOutputSize(int length) { return delegate.getOutputSize(length); }
        @Override protected byte[] engineGetIV() { return invalidNonce ? new byte[11] : delegate.getIV(); }
        @Override protected AlgorithmParameters engineGetParameters() { return delegate.getParameters(); }
        @Override protected void engineUpdateAAD(byte[] input, int offset, int length) {
            delegate.updateAAD(input, offset, length);
        }
        @Override protected byte[] engineUpdate(byte[] input, int offset, int length) {
            return delegate.update(input, offset, length);
        }
        @Override protected int engineUpdate(byte[] input, int offset, int length, byte[] output, int outputOffset)
            throws ShortBufferException {
            return delegate.update(input, offset, length, output, outputOffset);
        }
        @Override protected byte[] engineDoFinal(byte[] input, int offset, int length)
            throws IllegalBlockSizeException, BadPaddingException {
            return delegate.doFinal(input, offset, length);
        }
        @Override protected int engineDoFinal(byte[] input, int offset, int length, byte[] output, int outputOffset)
            throws ShortBufferException, IllegalBlockSizeException, BadPaddingException {
            return delegate.doFinal(input, offset, length, output, outputOffset);
        }
    }

    private static Cipher testCipher(CipherSpi spi) throws Exception {
        return Cipher.getInstance("AES/GCM/NoPadding", new TestProvider(spi));
    }

    private static final class TestProvider extends Provider {
        TestProvider(CipherSpi spi) {
            super("RandomizedEncryptionFixture", 1.0, "Android nonce policy fixture");
            putService(new Service(this, "Cipher", "AES/GCM/NoPadding", spi.getClass().getName(), null, null) {
                @Override public Object newInstance(Object parameters) { return spi; }
            });
        }
    }
}
