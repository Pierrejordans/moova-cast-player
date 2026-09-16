package com.moova.castplayer;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

final class CastConfig {
    private static final String DEFAULT_RECEIVER_APP_ID = "CC1AD845";

    private CastConfig() {}

    static String receiverAppId(Context context) {
        String fromCapacitor = fromCapacitorConfig(context);
        if (fromCapacitor != null && !fromCapacitor.isEmpty()) {
            return fromCapacitor;
        }
        try {
            String fromStrings = context.getString(R.string.cast_player_receiver_app_id);
            if (fromStrings != null && !fromStrings.isEmpty()) {
                return fromStrings;
            }
        } catch (Exception ignored) {
        }
        return DEFAULT_RECEIVER_APP_ID;
    }

    private static String fromCapacitorConfig(Context context) {
        try (InputStream stream = context.getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            JSONObject root = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
            JSONObject plugins = root.optJSONObject("plugins");
            if (plugins == null) {
                return null;
            }
            JSONObject castPlayer = plugins.optJSONObject("CastPlayer");
            if (castPlayer == null) {
                return null;
            }
            String id = castPlayer.optString("receiverAppId", "").trim();
            return id.isEmpty() ? null : id;
        } catch (Exception ignored) {
            return null;
        }
    }
}
