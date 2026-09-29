package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class HostProtocolContractTest {
    @Test
    public void protocolUsesSeparateResponseAndEventMessages() {
        assertEquals(2, BridgeProtocol.VERSION);
        assertEquals(1, BaseHostService.MESSAGE_REQUEST);
        assertEquals(2, BaseHostService.MESSAGE_RESPONSE);
        assertEquals(3, BaseHostService.MESSAGE_EVENT);
    }

    @Test
    public void languageAliasesMatchTheWebProviderContract() {
        assertEquals("didOpen", LanguageHostService.normalizeMethod("openDocument"));
        assertEquals("didChange", LanguageHostService.normalizeMethod("changeDocument"));
        assertEquals("completion", LanguageHostService.normalizeMethod("complete"));
        assertEquals(
            "completionItem/resolve",
            LanguageHostService.normalizeMethod("resolveCompletion"));
        assertEquals(
            "documentSymbol",
            LanguageHostService.normalizeMethod("documentSymbols"));
        assertEquals("hover", LanguageHostService.normalizeMethod("language/hover"));
    }

    @Test
    public void runtimeAdmissionAndStopShareTheOrderedIpcControlLane() {
        assertTrue(RuntimeHostService.isConcurrentRuntimeMethod("runFile"));
        assertTrue(RuntimeHostService.isConcurrentRuntimeMethod("sendInput"));
        assertTrue(RuntimeHostService.isConcurrentRuntimeMethod("stop"));
        assertTrue(RuntimeHostService.isConcurrentRuntimeMethod("$/cancelRequest"));
        assertFalse(RuntimeHostService.isConcurrentRuntimeMethod("capabilities"));
        assertFalse(RuntimeHostService.isConcurrentRuntimeMethod("activatePack"));
    }

    @Test
    public void privilegedEnvironmentChangesRequireBooleanConfirmation() throws Exception {
        JSONObject confirmedPayload = new JSONObject().put("confirmed", true);
        JSONObject request = new JSONObject().put("payload", confirmedPayload);
        assertTrue(PythonABridge.hasUserConfirmation(request));
        assertTrue(RuntimeHostService.hasUserConfirmation(confirmedPayload));

        JSONObject stringPayload = new JSONObject().put("confirmed", "true");
        assertFalse(PythonABridge.hasUserConfirmation(
            new JSONObject().put("payload", stringPayload)));
        assertFalse(RuntimeHostService.hasUserConfirmation(stringPayload));
        assertFalse(PythonABridge.hasUserConfirmation(new JSONObject()));
        assertFalse(RuntimeHostService.hasUserConfirmation(new JSONObject()));
    }

    @Test
    public void messengerTimeoutHonorsBoundedWebRequestPolicy() {
        assertEquals(60_000L, ServiceMessengerClient.boundRequestTimeoutMillis(60_000L));
        assertEquals(120_000L, ServiceMessengerClient.boundRequestTimeoutMillis(120_000L));
        assertEquals(1_000L, ServiceMessengerClient.boundRequestTimeoutMillis(1L));
        assertEquals(600_000L,
            ServiceMessengerClient.boundRequestTimeoutMillis(999_999_999L));
    }

    @Test
    public void webViewVersionGateParsesChromiumMajor() {
        assertEquals(64, MainActivity.parseWebViewMajor("64.0.3282.137"));
        assertEquals(120, MainActivity.parseWebViewMajor("120.0.6099.230"));
        assertEquals(-1, MainActivity.parseWebViewMajor("vendor-build"));
        assertEquals(-1, MainActivity.parseWebViewMajor(null));
    }
}
