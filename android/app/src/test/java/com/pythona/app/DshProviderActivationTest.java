package com.pythona.app;
import static org.junit.Assert.*;
import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;

public final class DshProviderActivationTest {
    private JSONObject catalog(String route, String model) throws Exception {
        return new JSONObject().put("providers", new JSONArray().put(new JSONObject()
            .put("id", route).put("models", new JSONArray().put(new JSONObject().put("id", model)))));
    }
    @Test public void waitsForSettingsConsumerInsteadOfReturningDefaultCatalog() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        JSONObject first = catalog("deepseek-official", "default");
        JSONObject second = catalog("pythona-custom", "saved-model");
        JSONObject result = DshProviderActivation.await(() -> attempts.incrementAndGet() < 3 ? first : second,
            "pythona-custom", "saved-model", 1000, 1);
        assertEquals(3, attempts.get());
        assertSame(second, result);
    }
    @Test public void staleModelDoesNotSatisfyNewConfiguration() throws Exception {
        JSONObject stale = catalog("pythona-custom", "old-model");
        assertThrows(IOException.class, () -> DshProviderActivation.await(() -> stale,
            "pythona-custom", "new-model", 0, 1));
    }
    @Test public void matchingModelFromDifferentRouteDoesNotCountAsApplied() throws Exception {
        assertFalse(DshProviderActivation.contains(catalog("compat", "saved-model"), "pythona-custom", "saved-model"));
    }
    @Test public void readyCatalogHasNoAdditionalWait() throws Exception {
        JSONObject ready = catalog("pythona-custom", "saved-model");
        assertSame(ready, DshProviderActivation.await(() -> ready, "pythona-custom", "saved-model", 0, 1));
    }
}
