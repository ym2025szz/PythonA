package com.pythona.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONObject;
import java.util.function.Consumer;

/** Native form: sensitive input never enters the WebView or its saved state. */
final class DshProviderDialog {
    interface Saver { void save(JSONObject payload, Consumer<JSONObject> completed); }
    static AlertDialog show(Activity activity, JSONObject initial, Saver save, Runnable cancel) {
        JSONObject prior = initial == null ? new JSONObject() : initial;
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * activity.getResources().getDisplayMetrics().density);
        form.setPadding(pad, pad / 2, pad, pad / 2);
        Spinner mode = new Spinner(activity);
        mode.setAdapter(new ArrayAdapter<>(activity, android.R.layout.simple_spinner_dropdown_item,
            new String[]{"自定义 OpenAI Chat Completions", "DeepSeek 官方"}));
        form.addView(mode);
        EditText name = field(activity, form, "Provider 名称", 128);
        EditText base = field(activity, form, "Base URL（通常到 /v1）", 2048);
        base.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText model = field(activity, form, "模型 ID", 256);
        model.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        EditText key = field(activity, form, "API Key（可稍后填写；留空保留原 Key）", 8192);
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        key.setSaveEnabled(false);
        CheckBox local = new CheckBox(activity);
        local.setText("允许本机回环端点（HTTP 仅限本机）");
        form.addView(local);
        TextView error = new TextView(activity);
        error.setTextColor(0xffc62828); form.addView(error);
        name.setText(prior.optString("displayName"));
        base.setText(prior.optString("baseUrl"));
        model.setText(prior.optString("model"));
        local.setChecked(prior.optBoolean("allowLocalEndpoint"));
        mode.setSelection("deepseek".equals(prior.optString("runtimeMode")) ? 1 : 0);
        final int[] previousMode = { mode.getSelectedItemPosition() };
        mode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onNothingSelected(AdapterView<?> parent) { }
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (previousMode[0] == position) return;
                previousMode[0] = position;
                if (position == 1) {
                    name.setText("DeepSeek"); base.setText("https://api.deepseek.com"); model.setText("deepseek-v4-flash");
                }
            }
        });
        ScrollView scroll = new ScrollView(activity); scroll.addView(form);
        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("配置 DSH Provider")
            .setMessage("模型由 PythonA 内置官方 dsh 调用。Key 只在原生窗口输入并由 Keystore 加密保存。")
            .setView(scroll).setPositiveButton("保存", null)
            .setNegativeButton("取消", (view, which) -> cancel.run()).setOnCancelListener(view -> cancel.run()).create();
        dialog.setOnDismissListener(view -> key.getText().clear());
        dialog.setOnShowListener(view -> {
            dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button -> {
                try {
                    JSONObject profile = DshCustomConfiguration.normalize(new JSONObject()
                        .put("displayName", name.getText().toString().trim()).put("baseUrl", base.getText().toString().trim())
                        .put("model", model.getText().toString().trim()).put("runtimeMode", mode.getSelectedItemPosition() == 1 ? "deepseek" : "custom")
                        .put("allowLocalEndpoint", local.isChecked()));
                    JSONObject payload = new JSONObject().put("profile", profile).put("secret", key.getText().toString().trim());
                    error.setTextColor(0xff666666);
                    error.setText("正在加密保存并确认模型配置，请稍候…");
                    for (View control : new View[]{mode, name, base, model, key, local}) control.setEnabled(false);
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
                    dialog.setCancelable(false);
                    Consumer<JSONObject> completed = response -> activity.runOnUiThread(() -> {
                        if (!dialog.isShowing()) return;
                        JSONObject result = response.optJSONObject("payload");
                        if (response.optBoolean("ok") && result != null && result.optBoolean("saved")) {
                            key.getText().clear();
                            dialog.dismiss();
                            return;
                        }
                        for (View control : new View[]{mode, name, base, model, key, local}) control.setEnabled(true);
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);
                        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
                        dialog.setCancelable(true);
                        error.setTextColor(0xffc62828);
                        JSONObject problem = response.optJSONObject("error");
                        error.setText("保存失败，内容尚未提交。\n" + (problem == null ? "请重试" : problem.optString("message", "请重试")));
                    });
                    try { save.save(payload, completed); }
                    catch (Exception failure) {
                        completed.accept(BridgeProtocol.error(null, "provider-save-failed", "原生保存暂不可用，请重试"));
                    }
                } catch (Exception invalid) { error.setText(invalid.getMessage()); }
            });
        });
        dialog.show();
        return dialog;
    }
    private static EditText field(Activity activity, LinearLayout parent, String label, int maximum) {
        TextView title = new TextView(activity); title.setText(label); parent.addView(title);
        EditText value = new EditText(activity); value.setSingleLine(true);
        value.setContentDescription(label); value.setFilters(new InputFilter[]{new InputFilter.LengthFilter(maximum)});
        value.setSaveEnabled(false); parent.addView(value);
        return value;
    }
}
