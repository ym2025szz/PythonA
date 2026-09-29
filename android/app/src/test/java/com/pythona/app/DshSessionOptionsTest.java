package com.pythona.app;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class DshSessionOptionsTest {
    private static final String OFFICIAL = "[\"deepseek-official\",\"flash\"]";
    private static final String CUSTOM = "[\"pythona-custom\",\"deepseek/deepseek-v4.1-flash\"]";

    private JSONObject state(String selected, String... levels) throws Exception {
        JSONObject model = new JSONObject().put("id", "model").put("type", "select")
            .put("currentValue", selected).put("options", new JSONArray()
                .put(new JSONObject().put("group", "deepseek-official").put("options", new JSONArray()
                    .put(new JSONObject().put("value", OFFICIAL))))
                .put(new JSONObject().put("group", "pythona-custom").put("options", new JSONArray()
                    .put(new JSONObject().put("value", CUSTOM)))));
        JSONArray options = new JSONArray().put(model);
        if (levels.length > 0) {
            JSONArray choices = new JSONArray();
            for (String level : levels) choices.put(new JSONObject().put("value", level));
            options.put(new JSONObject().put("id", "reasoning_effort").put("type", "select")
                .put("currentValue", levels[0]).put("options", choices));
        }
        return new JSONObject().put("sessionId", "acp-test").put("configOptions", options);
    }

    @Test public void customNonReasoningModelDoesNotReceiveInventedOffOption() throws Exception {
        JSONObject created = state(OFFICIAL, "high", "off");
        List<JSONObject> calls = new ArrayList<>();
        JSONObject result = DshSessionOptions.apply(created, "pythona-custom", "deepseek/deepseek-v4.1-flash", "off", (method, params) -> {
            assertEquals("session/set_config_option", method);
            calls.add(params);
            return state(CUSTOM);
        });
        assertEquals(1, calls.size());
        assertEquals("model", calls.get(0).getString("configId"));
        assertEquals(CUSTOM, calls.get(0).getString("value"));
        assertEquals("acp-test", calls.get(0).getString("sessionId"));
        assertEquals(1, result.getJSONArray("configOptions").length());
        assertEquals(2, created.getJSONArray("configOptions").length());
    }

    @Test public void unchangedNonReasoningModelNeedsNoConfigCall() throws Exception {
        DshSessionOptions.apply(state(CUSTOM), "pythona-custom", "deepseek/deepseek-v4.1-flash", "off", (method, params) -> {
            fail("A non-reasoning model must be usable without setting reasoning_effort");
            return null;
        });
    }

    @Test public void explicitUnsupportedReasoningIsRejected() throws Exception {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
            () -> DshSessionOptions.apply(state(CUSTOM), "pythona-custom", "deepseek/deepseek-v4.1-flash", "high", (method, params) -> null));
        assertTrue(error.getMessage().contains("dsh-reasoning-unsupported"));
    }

    @Test public void reasoningValidationUsesChangedModelsOptions() throws Exception {
        List<JSONObject> calls = new ArrayList<>();
        DshSessionOptions.apply(state(CUSTOM), "deepseek-official", "flash", "max", (method, params) -> {
            calls.add(params);
            return state(OFFICIAL, "high", "max");
        });
        assertEquals(2, calls.size());
        assertEquals("model", calls.get(0).getString("configId"));
        assertEquals("reasoning_effort", calls.get(1).getString("configId"));
        assertEquals("max", calls.get(1).getString("value"));
    }

    @Test public void doesNotReuseOldModelsReasoningChoices() throws Exception {
        List<JSONObject> calls = new ArrayList<>();
        assertThrows(IllegalArgumentException.class, () -> DshSessionOptions.apply(
            state(OFFICIAL, "high", "max"), "pythona-custom", "deepseek/deepseek-v4.1-flash", "max", (method, params) -> {
                calls.add(params);
                return state(CUSTOM, "low", "high");
            }));
        assertEquals(1, calls.size());
    }

    @Test public void advertisedOffIsAppliedWhenCurrentValueDiffers() throws Exception {
        List<JSONObject> calls = new ArrayList<>();
        DshSessionOptions.apply(state(OFFICIAL, "high", "off"), "deepseek-official", "flash", "off", (method, params) -> {
            calls.add(params);
            return state(OFFICIAL, "off", "high");
        });
        assertEquals(1, calls.size());
        assertEquals("reasoning_effort", calls.get(0).getString("configId"));
        assertEquals("off", calls.get(0).getString("value"));
    }

    @Test public void unavailableOffDoesNotSilentlySelectProviderDefault() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> DshSessionOptions.apply(
            state(OFFICIAL, "", "high"), "deepseek-official", "flash", "off", (method, params) -> null));
    }

    @Test public void missingModelFailsBeforeSendingAnyConfig() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> DshSessionOptions.apply(
            state(OFFICIAL), "missing", "flash", "off", (method, params) -> {
                fail("Unknown routes must not be sent");
                return null;
            }));
    }

    @Test public void opaqueAdvertisedModelValueIsPreserved() throws Exception {
        JSONObject created = state(OFFICIAL);
        String value = "[ \"pythona-custom\", \"deepseek/deepseek-v4.1-flash\" ]";
        created.getJSONArray("configOptions").getJSONObject(0).getJSONArray("options")
            .getJSONObject(1).getJSONArray("options").getJSONObject(0).put("value", value);
        DshSessionOptions.apply(created, "pythona-custom", "deepseek/deepseek-v4.1-flash", "off", (method, params) -> {
            assertEquals(value, params.getString("value"));
            return state(CUSTOM);
        });
    }

    @Test public void malformedConfigResponseCannotFallBackToPreviousOptions() throws Exception {
        assertThrows(IllegalStateException.class, () -> DshSessionOptions.apply(state(OFFICIAL, "high", "off"),
            "pythona-custom", "deepseek/deepseek-v4.1-flash", "off", (method, params) -> new JSONObject()));
    }
}
