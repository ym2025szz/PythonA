package com.pythona.app;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;

public final class DshInlineCapabilityTest {
    private JSONObject supported() throws Exception {
        return new JSONObject().put("version", 1).put("available", true).put("execution", "llm-only")
            .put("tools", false).put("sessions", false);
    }
    @Test public void disconnectedCannotClaimCapabilityOrCacheAColdResult() throws Exception {
        DshInlineCapability capability = new DshInlineCapability(); AtomicInteger calls = new AtomicInteger();
        DshInlineCapability.Probe probe = () -> { calls.incrementAndGet(); return supported(); };
        assertFalse(capability.resolve(1, false, probe).getBoolean("available")); assertEquals(0, calls.get());
        assertTrue(capability.resolve(1, true, probe).getBoolean("available")); assertEquals(1, calls.get());
    }
    @Test public void unknownOrMalformedCapabilitiesStayUnavailable() throws Exception {
        for (JSONObject response : new JSONObject[]{supported().put("version", 2), supported().put("version", "1"),
            supported().put("available", false), supported().put("available", "true"), supported().put("tools", true),
            supported().put("sessions", true), supported().put("execution", "agent"), new JSONObject()}) {
            assertFalse(new DshInlineCapability().resolve(1, true, () -> response).getBoolean("available"));
        }
    }
    @Test public void unavailableMethodIsCachedPerGenerationWithoutExposingErrorDetails() throws Exception {
        DshInlineCapability capability = new DshInlineCapability(); AtomicInteger calls = new AtomicInteger();
        DshInlineCapability.Probe missing = () -> { calls.incrementAndGet(); throw new IOException("private provider detail"); };
        JSONObject unavailable = capability.resolve(1, true, missing);
        assertFalse(unavailable.getBoolean("available")); assertFalse(unavailable.toString().contains("private"));
        assertFalse(capability.resolve(1, true, missing).getBoolean("available")); assertEquals(1, calls.get());
        assertTrue(capability.resolve(2, true, this::supported).getBoolean("available"));
    }
    @Test public void changingAResponseCannotPoisonTheCachedCapability() throws Exception {
        DshInlineCapability capability = new DshInlineCapability();
        JSONObject first = capability.resolve(1, true, this::supported); first.put("available", false);
        assertTrue(capability.resolve(1, true, () -> { fail("same generation queried twice"); return null; }).getBoolean("available"));
    }
    @Test public void nativeCompatibilityRouteDoesNotNeedToBootOrProbeOfficialDsh() throws Exception {
        JSONObject result = new DshInlineCapability().resolve(0, false, true, () -> {
            fail("A static HTTP capability must not boot or query official DSH"); return null;
        });
        assertTrue(result.getBoolean("available")); assertTrue(result.getBoolean("compatibilityAvailable"));
        assertFalse(result.getBoolean("officialAvailable")); assertEquals("runtime-not-ready", result.getString("officialReason"));
    }
    @Test public void officialFailureDoesNotDisableExplicitCompatibilityOrSelectItImplicitly() throws Exception {
        DshInlineCapability capability = new DshInlineCapability();
        JSONObject result = capability.resolve(1, true, true, () -> { throw new IOException("method unavailable"); });
        assertTrue(result.getBoolean("compatibilityAvailable")); assertFalse(result.getBoolean("officialAvailable"));
        assertTrue(result.getBoolean("available"));
        JSONObject unavailable = capability.resolve(1, true, false, this::supported);
        assertFalse(unavailable.getBoolean("available"));
        assertFalse(unavailable.getBoolean("compatibilityAvailable"));
    }
}
