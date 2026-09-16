package com.moova.castplayer;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.cast.CastDevice;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.CastState;
import com.google.android.gms.cast.framework.CastStateListener;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;
import com.google.android.gms.cast.CastMediaControlIntent;

import android.net.Uri;
import android.app.AlertDialog;
import org.json.JSONObject;
import android.content.DialogInterface;
import android.graphics.Color;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;
import java.util.ArrayList;

@CapacitorPlugin(name = "CastPlayer")
public class CastPlayerPlugin extends Plugin {

    private static final String TAG = "CastPlayerPlugin";
    private static final String DEFAULT_CAST_APP_ID = "CC1AD845";
    private String receiverAppId;
    private CastContext castContext;
    private SessionManager sessionManager;
    private CastSession currentSession;
    private RemoteMediaClient remoteMediaClient;
    private RemoteMediaClient.Callback mediaStatusCallback;
    private boolean isInitialized = false;

    private String getReceiverAppId() {
        if (receiverAppId != null && !receiverAppId.isEmpty()) {
            return receiverAppId;
        }
        try {
            String fromPluginConfig = getConfig().getString("receiverAppId");
            if (fromPluginConfig != null && !fromPluginConfig.isEmpty()) {
                return fromPluginConfig;
            }
        } catch (Exception ignored) {
        }
        return CastConfig.receiverAppId(getContext());
    }

    private CastStateListener castStateListener = new CastStateListener() {
        @Override
        public void onCastStateChanged(int state) {
            String stateName = state == CastState.NO_DEVICES_AVAILABLE ? "NO_DEVICES" :
                              state == CastState.NOT_CONNECTED ? "NOT_CONNECTED" :
                              state == CastState.CONNECTING ? "CONNECTING" :
                              state == CastState.CONNECTED ? "CONNECTED" : "UNKNOWN";
            Log.d(TAG, "CastState changed: " + state + " (" + stateName + ")");

            // Log all available routes for debugging
            try {
                MediaRouter mediaRouter = MediaRouter.getInstance(getContext());
                java.util.List<MediaRouter.RouteInfo> routes = mediaRouter.getRoutes();
                Log.d(TAG, "Total MediaRouter routes: " + routes.size());

                // Check with both selectors
                String RECEIVER_APP_ID = getReceiverAppId();
                MediaRouteSelector customSelector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(RECEIVER_APP_ID))
                    .build();
                MediaRouteSelector defaultSelector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(DEFAULT_CAST_APP_ID))
                    .build();

                for (MediaRouter.RouteInfo route : routes) {
                    boolean matchesCustom = route.matchesSelector(customSelector);
                    boolean matchesDefault = route.matchesSelector(defaultSelector);
                    Log.d(TAG, "  Route: " + route.getName() +
                          " - enabled: " + route.isEnabled() +
                          " - isDefault: " + route.isDefault() +
                          " - description: " + route.getDescription() +
                          " - matchesCustom(" + RECEIVER_APP_ID + "): " + matchesCustom +
                          " - matchesDefault(" + DEFAULT_CAST_APP_ID + "): " + matchesDefault);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error logging routes", e);
            }

            JSObject ret = new JSObject();
            ret.put("available", state != CastState.NO_DEVICES_AVAILABLE);
            notifyListeners("availabilityChanged", ret);
        }
    };

    private SessionManagerListener<CastSession> sessionManagerListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarting(CastSession session) {
            notifySessionState("starting", null);
        }

        @Override
        public void onSessionStarted(CastSession session, String sessionId) {
            currentSession = session;
            remoteMediaClient = session.getRemoteMediaClient();
            setupRemoteMediaClientListeners();
            CastDevice device = session.getCastDevice();
            notifySessionState("connected", device != null ? device.getFriendlyName() : null);
        }

        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            notifySessionState("failed", null);
        }

        @Override
        public void onSessionEnding(CastSession session) {
            notifySessionState("ending", null);
        }

        @Override
        public void onSessionEnded(CastSession session, int error) {
            currentSession = null;
            mediaStatusCallback = null;
            remoteMediaClient = null;
            notifySessionState("disconnected", null);
        }

        @Override
        public void onSessionResuming(CastSession session, String sessionId) {
            notifySessionState("resuming", null);
        }

        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            currentSession = session;
            remoteMediaClient = session.getRemoteMediaClient();
            setupRemoteMediaClientListeners();
            CastDevice device = session.getCastDevice();
            notifySessionState("connected", device != null ? device.getFriendlyName() : null);
        }

        @Override
        public void onSessionSuspended(CastSession session, int reason) {
            notifySessionState("suspended", null);
        }

        @Override
        public void onSessionResumeFailed(CastSession session, int error) {
            notifySessionState("failed", null);
        }
    };

    private void notifySessionState(String state, String deviceName) {
        JSObject ret = new JSObject();
        ret.put("state", state);
        if (deviceName != null) {
            ret.put("deviceName", deviceName);
        }
        notifyListeners("sessionStateChanged", ret);
    }

    private void setupRemoteMediaClientListeners() {
        if (remoteMediaClient == null) return;

        // Avoid stacking callbacks across session resume / re-setup
        if (mediaStatusCallback != null) {
            try {
                remoteMediaClient.unregisterCallback(mediaStatusCallback);
            } catch (Exception ignored) {
            }
            mediaStatusCallback = null;
        }

        mediaStatusCallback = new RemoteMediaClient.Callback() {
            @Override
            public void onStatusUpdated() {
                if (remoteMediaClient == null) return;
                MediaStatus status = remoteMediaClient.getMediaStatus();
                if (status != null) {
                    JSObject ret = new JSObject();
                    int playerState = status.getPlayerState();
                    ret.put("playerState", getPlayerStateString(playerState));
                    ret.put("idleReason", getIdleReasonString(playerState, status.getIdleReason()));
                    ret.put("currentTime", status.getStreamPosition() / 1000.0);
                    double durationSec = 0;
                    if (status.getMediaInfo() != null) {
                        long streamDuration = status.getMediaInfo().getStreamDuration();
                        // Cast SDK uses negative values for unknown duration
                        if (streamDuration > 0) {
                            durationSec = streamDuration / 1000.0;
                        }
                    }
                    ret.put("duration", durationSec);
                    ret.put("volume", status.getStreamVolume());
                    ret.put("muted", status.isMute());
                    notifyListeners("mediaStateChanged", ret);
                }
            }
        };
        remoteMediaClient.registerCallback(mediaStatusCallback);
    }

    private String getPlayerStateString(int state) {
        switch (state) {
            case MediaStatus.PLAYER_STATE_IDLE:
                return "idle";
            case MediaStatus.PLAYER_STATE_PLAYING:
                return "playing";
            case MediaStatus.PLAYER_STATE_PAUSED:
                return "paused";
            case MediaStatus.PLAYER_STATE_BUFFERING:
                return "buffering";
            case MediaStatus.PLAYER_STATE_LOADING:
                return "loading";
            default:
                return "unknown";
        }
    }

    private String getIdleReasonString(int playerState, int idleReason) {
        if (playerState != MediaStatus.PLAYER_STATE_IDLE) {
            return "none";
        }
        switch (idleReason) {
            case MediaStatus.IDLE_REASON_FINISHED:
                return "finished";
            case MediaStatus.IDLE_REASON_CANCELED:
                return "canceled";
            case MediaStatus.IDLE_REASON_INTERRUPTED:
                return "interrupted";
            case MediaStatus.IDLE_REASON_ERROR:
                return "error";
            case MediaStatus.IDLE_REASON_NONE:
            default:
                return "none";
        }
    }

    // Helper method to recursively set white background on all views
    private void forceWhiteBackground(android.view.View view) {
        if (view == null) return;

        // Set background to white (except for text views which we want to keep transparent)
        if (!(view instanceof TextView)) {
            view.setBackgroundColor(Color.WHITE);
        }

        // If it's a ViewGroup, recurse through children
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                forceWhiteBackground(group.getChildAt(i));
            }
        }
    }

    @PluginMethod
    public void initialize(PluginCall call) {
        Log.d(TAG, "=== initialize called ===");
        String appId = call.getString("receiverAppId");
        if (appId != null && !appId.isEmpty()) {
            receiverAppId = appId;
        }
        try {
            getActivity().runOnUiThread(() -> {
                try {
                    Log.d(TAG, "Getting CastContext.getSharedInstance...");
                    castContext = CastContext.getSharedInstance(getContext());
                    Log.d(TAG, "CastContext obtained: " + castContext);

                    sessionManager = castContext.getSessionManager();
                    Log.d(TAG, "SessionManager obtained: " + sessionManager);

                    // Add listeners
                    castContext.addCastStateListener(castStateListener);
                    sessionManager.addSessionManagerListener(sessionManagerListener, CastSession.class);
                    Log.d(TAG, "Listeners added");

                    // Log initial Cast state
                    int castState = castContext.getCastState();
                    String stateName = castState == CastState.NO_DEVICES_AVAILABLE ? "NO_DEVICES" :
                                      castState == CastState.NOT_CONNECTED ? "NOT_CONNECTED" :
                                      castState == CastState.CONNECTING ? "CONNECTING" :
                                      castState == CastState.CONNECTED ? "CONNECTED" : "UNKNOWN";
                    Log.d(TAG, "Initial CastState: " + castState + " (" + stateName + ")");

                    // Log all available routes for debugging
                    try {
                        MediaRouter mediaRouter = MediaRouter.getInstance(getContext());
                        java.util.List<MediaRouter.RouteInfo> routes = mediaRouter.getRoutes();
                        Log.d(TAG, "Initial MediaRouter routes count: " + routes.size());
                        for (MediaRouter.RouteInfo route : routes) {
                            Log.d(TAG, "  Initial Route: " + route.getName() +
                                  " - enabled: " + route.isEnabled() +
                                  " - isDefault: " + route.isDefault() +
                                  " - description: " + route.getDescription());
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Error logging initial routes", e);
                    }

                    // Check for existing session
                    currentSession = sessionManager.getCurrentCastSession();
                    if (currentSession != null) {
                        Log.d(TAG, "Existing session found: " + currentSession.getSessionId());
                        remoteMediaClient = currentSession.getRemoteMediaClient();
                        setupRemoteMediaClientListeners();
                    } else {
                        Log.d(TAG, "No existing session");
                    }

                    isInitialized = true;
                    Log.d(TAG, "=== Chromecast initialized successfully ===");
                    call.resolve();
                } catch (Exception e) {
                    Log.e(TAG, "Failed to initialize Chromecast", e);
                    call.reject("Failed to initialize: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Exception in initialize outer block", e);
            call.reject("Failed to initialize: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            if (castContext != null) {
                int state = castContext.getCastState();
                ret.put("available", state != CastState.NO_DEVICES_AVAILABLE);
            } else {
                ret.put("available", false);
            }
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void restartDiscovery(PluginCall call) {
        Log.d(TAG, "=== restartDiscovery called ===");

        getActivity().runOnUiThread(() -> {
            try {
                if (castContext == null) {
                    Log.d(TAG, "CastContext is null, re-initializing...");
                    castContext = CastContext.getSharedInstance(getContext());
                    sessionManager = castContext.getSessionManager();
                    castContext.addCastStateListener(castStateListener);
                    sessionManager.addSessionManagerListener(sessionManagerListener, CastSession.class);
                }

                // Get MediaRouter and trigger route scan
                MediaRouter mediaRouter = MediaRouter.getInstance(getContext());

                // Create selector for Cast devices
                String RECEIVER_APP_ID = getReceiverAppId();
                MediaRouteSelector selector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(RECEIVER_APP_ID))
                    .build();

                // Add callback to trigger active scanning with both selectors
                MediaRouter.Callback routeCallback = new MediaRouter.Callback() {
                    @Override
                    public void onRouteAdded(MediaRouter router, MediaRouter.RouteInfo route) {
                        boolean matchesCustom = route.matchesSelector(selector);
                        boolean matchesDefault = false;
                        try {
                            MediaRouteSelector defaultSelector = new MediaRouteSelector.Builder()
                                .addControlCategory(CastMediaControlIntent.categoryForCast("CC1AD845"))
                                .build();
                            matchesDefault = route.matchesSelector(defaultSelector);
                        } catch (Exception e) {
                            // Ignore
                        }
                        Log.d(TAG, "✓ Route discovered: " + route.getName() +
                              " - matchesCustom: " + matchesCustom +
                              " - matchesDefault: " + matchesDefault +
                              " - enabled: " + route.isEnabled());
                    }

                    @Override
                    public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) {
                        Log.d(TAG, "Route changed: " + route.getName() +
                              " - enabled: " + route.isEnabled());
                    }

                    @Override
                    public void onRouteRemoved(MediaRouter router, MediaRouter.RouteInfo route) {
                        Log.d(TAG, "Route removed: " + route.getName());
                    }
                };

                // Add callback with active scan flag to force discovery
                mediaRouter.addCallback(selector, routeCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);

                // Also add callback for default Cast selector to discover all Cast devices
                try {
                    MediaRouteSelector defaultSelector = new MediaRouteSelector.Builder()
                        .addControlCategory(CastMediaControlIntent.categoryForCast("CC1AD845"))
                        .build();
                    mediaRouter.addCallback(defaultSelector, routeCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
                    Log.d(TAG, "Added callback for default Cast selector to discover all Cast devices");
                } catch (Exception e) {
                    Log.e(TAG, "Failed to add default Cast selector callback", e);
                }

                // Log all current routes
                java.util.List<MediaRouter.RouteInfo> currentRoutes = mediaRouter.getRoutes();
                Log.d(TAG, "Current routes count: " + currentRoutes.size());
                for (MediaRouter.RouteInfo route : currentRoutes) {
                    Log.d(TAG, "  Route: " + route.getName() +
                          " - enabled: " + route.isEnabled() +
                          " - matchesSelector: " + route.matchesSelector(selector) +
                          " - description: " + route.getDescription());
                }

                // Check for existing session
                currentSession = sessionManager.getCurrentCastSession();
                if (currentSession != null && currentSession.isConnected()) {
                    Log.d(TAG, "Found existing connected session: " + currentSession.getSessionId());
                    remoteMediaClient = currentSession.getRemoteMediaClient();
                    setupRemoteMediaClientListeners();
                } else {
                    Log.d(TAG, "No existing connected session");
                }

                int castState = castContext.getCastState();
                String stateName = castState == CastState.NO_DEVICES_AVAILABLE ? "NO_DEVICES" :
                                  castState == CastState.NOT_CONNECTED ? "NOT_CONNECTED" :
                                  castState == CastState.CONNECTING ? "CONNECTING" :
                                  castState == CastState.CONNECTED ? "CONNECTED" : "UNKNOWN";
                Log.d(TAG, "CastState after restart: " + castState + " (" + stateName + ")");

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("castState", castState);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "Failed to restart discovery", e);
                call.reject("Failed to restart discovery: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void requestSession(PluginCall call) {
        Log.d(TAG, "=== requestSession called ===");

        if (!isInitialized || castContext == null) {
            Log.e(TAG, "Chromecast not initialized - isInitialized: " + isInitialized + ", castContext: " + castContext);
            call.reject("Chromecast not initialized");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                // Log Cast state
                int castState = castContext.getCastState();
                Log.d(TAG, "Current CastState: " + castState + " (1=NO_DEVICES, 2=NOT_CONNECTED, 3=CONNECTING, 4=CONNECTED)");

                // Create MediaRouteSelector for Cast devices with custom Moova receiver
                String RECEIVER_APP_ID = getReceiverAppId();
                Log.d(TAG, "Using RECEIVER_APP_ID: " + RECEIVER_APP_ID);

                MediaRouteSelector selector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(RECEIVER_APP_ID))
                    .build();
                Log.d(TAG, "MediaRouteSelector created: " + selector.toString());

                // Check MediaRouter for available routes
                MediaRouter mediaRouter = MediaRouter.getInstance(getContext());
                java.util.List<MediaRouter.RouteInfo> routes = mediaRouter.getRoutes();
                Log.d(TAG, "Total MediaRouter routes: " + routes.size());
                for (MediaRouter.RouteInfo route : routes) {
                    Log.d(TAG, "  Route: " + route.getName() + " - " + route.getDescription() + " - isDefault: " + route.isDefault() + " - matchesSelector: " + route.matchesSelector(selector));
                }

                // Create custom dialog instead of MediaRouteChooserDialog
                // This gives us full control over the appearance
                Log.d(TAG, "Creating custom Cast device chooser dialog...");

                // Get available Cast routes
                ArrayList<MediaRouter.RouteInfo> castRoutes = new ArrayList<>();
                ArrayList<String> routeNames = new ArrayList<>();

                Log.d(TAG, "Filtering routes with selector for Receiver App ID: " + RECEIVER_APP_ID);
                for (MediaRouter.RouteInfo route : routes) {
                    boolean matchesSelector = route.matchesSelector(selector);
                    Log.d(TAG, "  Route: " + route.getName() +
                          " - matchesSelector: " + matchesSelector +
                          " - isDefault: " + route.isDefault() +
                          " - isEnabled: " + route.isEnabled());

                    if (!route.isDefault() && matchesSelector) {
                        castRoutes.add(route);
                        String name = route.getName().toString();
                        String desc = route.getDescription();
                        if (desc != null && !desc.isEmpty()) {
                            name += " - " + desc;
                        }
                        routeNames.add(name);
                        Log.d(TAG, "✓ Added Cast route (matches selector): " + name);
                    }
                }

                // If no matching routes, also add routes that support casting in general
                // This is a fallback for cases where the receiver App ID hasn't been validated yet
                if (castRoutes.isEmpty()) {
                    Log.d(TAG, "No routes matched selector, trying fallback (all enabled Cast routes)");

                    // Create a generic Cast selector using Google's default Cast App ID
                    // This will match any Cast device, not just those with our custom receiver
                    // CC1AD845 is Google's default media receiver App ID
                    String DEFAULT_CAST_APP_ID = "CC1AD845";
                    MediaRouteSelector genericCastSelector = new MediaRouteSelector.Builder()
                        .addControlCategory(CastMediaControlIntent.categoryForCast(DEFAULT_CAST_APP_ID))
                        .build();

                    for (MediaRouter.RouteInfo route : routes) {
                        if (!route.isDefault() && route.isEnabled()) {
                            // Check if it's a Cast route by matching generic Cast selector
                            boolean isCastRoute = false;

                            try {
                                // Check if route matches generic Cast category (default Cast App ID)
                                if (route.matchesSelector(genericCastSelector)) {
                                    isCastRoute = true;
                                    Log.d(TAG, "Route matches generic Cast selector: " + route.getName());
                                }
                            } catch (Exception e) {
                                Log.d(TAG, "Error checking generic Cast selector: " + e.getMessage());
                            }

                            // Also check if route description suggests it's a Cast device
                            String desc = route.getDescription();
                            if (!isCastRoute && desc != null &&
                                (desc.contains("Chromecast") || desc.contains("Cast") ||
                                 desc.contains("Google") || desc.toLowerCase().contains("cast"))) {
                                isCastRoute = true;
                                Log.d(TAG, "Route identified as Cast by description: " + route.getName());
                            }

                            if (isCastRoute) {
                                castRoutes.add(route);
                                String name = route.getName().toString();
                                if (desc != null && !desc.isEmpty()) {
                                    name += " - " + desc;
                                }
                                routeNames.add(name);
                                Log.d(TAG, "✓ Added fallback Cast route: " + name + " (will try to connect with custom receiver)");
                            }
                        }
                    }
                }

                if (castRoutes.isEmpty()) {
                    Log.d(TAG, "No Cast devices found");
                    call.reject("Aucun appareil Cast trouvé");
                    return;
                }

                Log.d(TAG, "Found " + castRoutes.size() + " Cast devices");

                // Create AlertDialog with EXPLICIT light theme
                AlertDialog.Builder builder = new AlertDialog.Builder(
                    getActivity(),
                    android.R.style.Theme_Material_Light_Dialog_Alert
                );

                // Create custom title view with white background
                TextView titleView = new TextView(getActivity());
                titleView.setText("Sélectionnez un appareil");
                titleView.setTextColor(Color.BLACK);
                titleView.setBackgroundColor(Color.WHITE);
                titleView.setTextSize(18);
                titleView.setPadding(50, 40, 50, 20);
                titleView.setTypeface(null, android.graphics.Typeface.BOLD);
                builder.setCustomTitle(titleView);

                // Get Cast icon drawable by searching for it dynamically
                android.graphics.drawable.Drawable castIcon = null;
                try {
                    // Try various possible icon names
                    String[] iconNames = {
                        "mr_ic_cast_dark",
                        "ic_cast_dark_24dp",
                        "ic_media_route_off_mono_dark",
                        "quantum_ic_cast_grey600_24"
                    };
                    int iconResId = 0;
                    for (String iconName : iconNames) {
                        iconResId = getContext().getResources().getIdentifier(iconName, "drawable", getContext().getPackageName());
                        if (iconResId != 0) {
                            Log.d(TAG, "Found cast icon: " + iconName);
                            break;
                        }
                    }
                    if (iconResId != 0) {
                        castIcon = androidx.core.content.ContextCompat.getDrawable(getContext(), iconResId);
                    }
                } catch (Exception e) {
                    Log.d(TAG, "Could not load cast icon: " + e.getMessage());
                }
                final android.graphics.drawable.Drawable finalCastIcon = castIcon;

                // Create custom adapter with explicit colors and Cast icon
                ArrayAdapter<String> adapter = new ArrayAdapter<String>(
                    getActivity(),
                    android.R.layout.simple_list_item_1,
                    routeNames
                ) {
                    @Override
                    public android.view.View getView(int position, android.view.View convertView, android.view.ViewGroup parent) {
                        android.view.View view = super.getView(position, convertView, parent);
                        TextView textView = (TextView) view;
                        textView.setTextColor(Color.BLACK);
                        textView.setBackgroundColor(Color.WHITE);
                        textView.setPadding(40, 30, 40, 30);
                        textView.setTextSize(16);
                        textView.setCompoundDrawablePadding(24);
                        // Add Cast icon to the left of the text
                        textView.setCompoundDrawablesWithIntrinsicBounds(finalCastIcon, null, null, null);
                        return view;
                    }
                };

                builder.setAdapter(adapter, (dialogInterface, which) -> {
                    MediaRouter.RouteInfo selectedRoute = castRoutes.get(which);
                    Log.d(TAG, "User selected route: " + selectedRoute.getName());
                    mediaRouter.selectRoute(selectedRoute);
                });

                builder.setNegativeButton("Annuler", (dialogInterface, which) -> {
                    dialogInterface.dismiss();
                });

                AlertDialog alertDialog = builder.create();

                // Set the entire dialog background to white before showing
                alertDialog.setOnShowListener(dialog -> {
                    AlertDialog d = (AlertDialog) dialog;

                    // Set dialog width to 75% of screen width
                    if (d.getWindow() != null) {
                        android.view.WindowManager.LayoutParams params = d.getWindow().getAttributes();
                        android.util.DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
                        params.width = (int) (metrics.widthPixels * 0.75);
                        d.getWindow().setAttributes(params);

                        // Force white background
                        d.getWindow().getDecorView().setBackgroundColor(Color.WHITE);
                    }

                    // Force white on ALL child views recursively
                    if (d.getWindow() != null) {
                        forceWhiteBackground(d.getWindow().getDecorView());
                    }

                    // Style the cancel button
                    android.widget.Button negativeButton = d.getButton(AlertDialog.BUTTON_NEGATIVE);
                    if (negativeButton != null) {
                        negativeButton.setTextColor(Color.parseColor("#007AFF"));
                    }
                });

                alertDialog.show();

                Log.d(TAG, "Custom dialog shown with " + castRoutes.size() + " devices");

                // The session connection will be handled by the SessionManagerListener
                // Resolve immediately and let the listener notify of state changes
                JSObject ret = new JSObject();
                ret.put("sessionId", "pending");
                ret.put("deviceName", "");
                call.resolve(ret);
                Log.d(TAG, "requestSession completed, dialog shown");
            } catch (Exception e) {
                Log.e(TAG, "Failed to request session", e);
                call.reject("Failed to request session: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void endSession(PluginCall call) {
        if (sessionManager != null) {
            getActivity().runOnUiThread(() -> {
                sessionManager.endCurrentSession(true);
                call.resolve();
            });
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void loadMedia(PluginCall call) {
        if (remoteMediaClient == null) {
            call.reject("No active cast session");
            return;
        }

        String url = call.getString("url");
        String contentType = call.getString("contentType", "application/x-mpegURL");
        String title = call.getString("title", "");
        String description = call.getString("description", "");
        String posterUrl = call.getString("posterUrl");
        Double startPosition = call.getDouble("startPosition", 0.0);
        Boolean autoplay = call.getBoolean("autoplay", true);

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        // Clean URL: remove escaped slashes that may come from JSON serialization
        final String cleanUrl = url.replace("\\/", "/");
        Log.d(TAG, "Loading media URL: " + cleanUrl);

        getActivity().runOnUiThread(() -> {
            try {
                MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
                metadata.putString(MediaMetadata.KEY_TITLE, title);
                metadata.putString(MediaMetadata.KEY_SUBTITLE, description);

                if (posterUrl != null && !posterUrl.isEmpty()) {
                    metadata.addImage(new WebImage(Uri.parse(posterUrl)));
                }

                // For HLS streams, determine stream type based on content type
                int streamType = MediaInfo.STREAM_TYPE_BUFFERED;
                if (contentType.contains("mpegURL") || contentType.contains("mpegurl") || contentType.contains("m3u8")) {
                    // HLS streams often work better with STREAM_TYPE_LIVE or NONE
                    streamType = MediaInfo.STREAM_TYPE_NONE;
                    Log.d(TAG, "Using STREAM_TYPE_NONE for HLS content");
                }

                MediaInfo.Builder mediaInfoBuilder = new MediaInfo.Builder(cleanUrl)
                    .setContentType(contentType)
                    .setStreamType(streamType)
                    .setMetadata(metadata);

                MediaInfo mediaInfo = mediaInfoBuilder.build();

                // Build load request - start from beginning if startPosition is small
                MediaLoadRequestData.Builder loadRequestBuilder = new MediaLoadRequestData.Builder()
                    .setMediaInfo(mediaInfo)
                    .setAutoplay(autoplay);

                // Only set start position if it's significant (> 1 second)
                long startTimeMs = (long)(startPosition * 1000);
                if (startTimeMs > 1000) {
                    loadRequestBuilder.setCurrentTime(startTimeMs);
                }

                // Pass customData to receiver (e.g. auth token, tracking payload)
                try {
                    JSObject customDataObj = call.getObject("customData");
                    if (customDataObj != null && customDataObj.length() > 0) {
                        loadRequestBuilder.setCustomData(new JSONObject(customDataObj.toString()));
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Could not set customData for receiver", e);
                }

                MediaLoadRequestData loadRequest = loadRequestBuilder.build();

                Log.d(TAG, "Loading HLS stream - ContentType: " + contentType + ", StartPos: " + startTimeMs + "ms");

                remoteMediaClient.load(loadRequest).setResultCallback(result -> {
                    if (result.getStatus().isSuccess()) {
                        Log.d(TAG, "Media loaded successfully");
                        call.resolve();
                    } else {
                        int statusCode = result.getStatus().getStatusCode();
                        String statusMessage = result.getStatus().getStatusMessage();
                        Log.e(TAG, "Failed to load media - Code: " + statusCode + ", Message: " + statusMessage);
                        call.reject("Failed to load media: " + statusCode + " - " + statusMessage);
                    }
                });
            } catch (Exception e) {
                Log.e(TAG, "Failed to load media", e);
                call.reject("Failed to load media: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        if (remoteMediaClient == null) {
            call.reject("No active cast session");
            return;
        }
        getActivity().runOnUiThread(() -> {
            remoteMediaClient.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (remoteMediaClient == null) {
            call.reject("No active cast session");
            return;
        }
        getActivity().runOnUiThread(() -> {
            remoteMediaClient.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        if (remoteMediaClient == null) {
            call.reject("No active cast session");
            return;
        }
        Double position = call.getDouble("position", 0.0);
        getActivity().runOnUiThread(() -> {
            remoteMediaClient.seek((long)(position * 1000));
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (remoteMediaClient == null) {
            call.reject("No active cast session");
            return;
        }
        getActivity().runOnUiThread(() -> {
            remoteMediaClient.stop();
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        if (remoteMediaClient == null) {
            call.reject("No active cast session");
            return;
        }
        Double volume = call.getDouble("volume", 1.0);
        getActivity().runOnUiThread(() -> {
            remoteMediaClient.setStreamVolume(volume);
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();

            if (castContext != null) {
                int castState = castContext.getCastState();
                ret.put("available", castState != CastState.NO_DEVICES_AVAILABLE);
                ret.put("castState", castState);
                String stateName = castState == CastState.NO_DEVICES_AVAILABLE ? "NO_DEVICES" :
                                  castState == CastState.NOT_CONNECTED ? "NOT_CONNECTED" :
                                  castState == CastState.CONNECTING ? "CONNECTING" :
                                  castState == CastState.CONNECTED ? "CONNECTED" : "UNKNOWN";
                ret.put("castStateName", stateName);
            } else {
                ret.put("available", false);
                ret.put("castState", CastState.NO_DEVICES_AVAILABLE);
                ret.put("castStateName", "NOT_INITIALIZED");
            }

            ret.put("connected", currentSession != null && currentSession.isConnected());
            ret.put("initialized", isInitialized);

            if (currentSession != null && currentSession.getCastDevice() != null) {
                ret.put("deviceName", currentSession.getCastDevice().getFriendlyName());
                ret.put("sessionId", currentSession.getSessionId());
            }

            call.resolve(ret);
        });
    }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        Log.d(TAG, "=== getDiagnostics called ===");
        getActivity().runOnUiThread(() -> {
            try {
                JSObject diagnostics = new JSObject();

                // Basic state
                diagnostics.put("initialized", isInitialized);
                diagnostics.put("hasCastContext", castContext != null);
                diagnostics.put("hasSessionManager", sessionManager != null);
                diagnostics.put("hasCurrentSession", currentSession != null);
                diagnostics.put("hasRemoteMediaClient", remoteMediaClient != null);

                // Cast Context state
                if (castContext != null) {
                    int castState = castContext.getCastState();
                    String stateName = castState == CastState.NO_DEVICES_AVAILABLE ? "NO_DEVICES" :
                                      castState == CastState.NOT_CONNECTED ? "NOT_CONNECTED" :
                                      castState == CastState.CONNECTING ? "CONNECTING" :
                                      castState == CastState.CONNECTED ? "CONNECTED" : "UNKNOWN";

                    JSObject castContextInfo = new JSObject();
                    castContextInfo.put("castState", castState);
                    castContextInfo.put("castStateName", stateName);
                    castContextInfo.put("available", castState != CastState.NO_DEVICES_AVAILABLE);
                    diagnostics.put("castContext", castContextInfo);
                } else {
                    JSObject castContextInfo = new JSObject();
                    castContextInfo.put("castState", CastState.NO_DEVICES_AVAILABLE);
                    castContextInfo.put("castStateName", "NOT_INITIALIZED");
                    castContextInfo.put("available", false);
                    diagnostics.put("castContext", castContextInfo);
                }

                // Current session info
                if (currentSession != null) {
                    JSObject sessionInfo = new JSObject();
                    sessionInfo.put("sessionId", currentSession.getSessionId());
                    sessionInfo.put("isConnected", currentSession.isConnected());
                    sessionInfo.put("isConnecting", currentSession.isConnecting());

                    CastDevice device = currentSession.getCastDevice();
                    if (device != null) {
                        JSObject deviceInfo = new JSObject();
                        deviceInfo.put("friendlyName", device.getFriendlyName());
                        deviceInfo.put("modelName", device.getModelName());
                        deviceInfo.put("deviceVersion", device.getDeviceVersion());
                        deviceInfo.put("ipAddress", device.getIpAddress().toString());
                        deviceInfo.put("servicePort", device.getServicePort());
                        sessionInfo.put("device", deviceInfo);
                    }
                    diagnostics.put("currentSession", sessionInfo);
                } else {
                    diagnostics.put("currentSession", null);
                }

                // MediaRouter routes analysis
                try {
                    MediaRouter mediaRouter = MediaRouter.getInstance(getContext());
                    java.util.List<MediaRouter.RouteInfo> routes = mediaRouter.getRoutes();

                    JSObject routesInfo = new JSObject();
                    routesInfo.put("totalRoutes", routes.size());

                    String RECEIVER_APP_ID = getReceiverAppId();
                    MediaRouteSelector selector = new MediaRouteSelector.Builder()
                        .addControlCategory(CastMediaControlIntent.categoryForCast(RECEIVER_APP_ID))
                        .build();

                    // Create a generic Cast selector using Google's default Cast App ID
                    // This will match any Cast device, not just those with our custom receiver
                    // CC1AD845 is Google's default media receiver App ID
                    String DEFAULT_CAST_APP_ID = "CC1AD845";
                    MediaRouteSelector genericCastSelector = new MediaRouteSelector.Builder()
                        .addControlCategory(CastMediaControlIntent.categoryForCast(DEFAULT_CAST_APP_ID))
                        .build();

                    ArrayList<JSObject> routeDetails = new ArrayList<>();
                    int matchingRoutes = 0;
                    int enabledRoutes = 0;
                    int castRoutes = 0;

                    for (MediaRouter.RouteInfo route : routes) {
                        JSObject routeDetail = new JSObject();
                        routeDetail.put("name", route.getName().toString());
                        routeDetail.put("description", route.getDescription() != null ? route.getDescription() : "");
                        routeDetail.put("isDefault", route.isDefault());
                        routeDetail.put("isEnabled", route.isEnabled());
                        routeDetail.put("isSelected", route.isSelected());
                        routeDetail.put("matchesSelector", route.matchesSelector(selector));

                        // Try to determine if it's a Cast device
                        boolean isCastDevice = false;
                        try {
                            // Check if route matches generic Cast category
                            if (route.matchesSelector(genericCastSelector)) {
                                isCastDevice = true;
                            }
                        } catch (Exception e) {
                            // Ignore
                        }

                        // Also check if route description suggests it's a Cast device
                        String desc = route.getDescription();
                        if (!isCastDevice && desc != null &&
                            (desc.contains("Chromecast") || desc.contains("Cast") ||
                             desc.contains("Google") || desc.toLowerCase().contains("cast"))) {
                            isCastDevice = true;
                        }

                        routeDetail.put("isCastDevice", isCastDevice);

                        if (route.matchesSelector(selector)) {
                            matchingRoutes++;
                        }
                        if (route.isEnabled()) {
                            enabledRoutes++;
                        }
                        if (isCastDevice) {
                            castRoutes++;
                        }

                        routeDetails.add(routeDetail);
                    }

                    routesInfo.put("matchingRoutes", matchingRoutes);
                    routesInfo.put("enabledRoutes", enabledRoutes);
                    routesInfo.put("castRoutes", castRoutes);
                    routesInfo.put("routes", routeDetails);
                    diagnostics.put("mediaRouter", routesInfo);

                    Log.d(TAG, "Diagnostics - Total routes: " + routes.size() +
                          ", Matching selector: " + matchingRoutes +
                          ", Cast devices: " + castRoutes);

                } catch (Exception e) {
                    Log.e(TAG, "Error getting MediaRouter info", e);
                    diagnostics.put("mediaRouterError", e.getMessage());
                }

                // Receiver App ID info
                JSObject receiverInfo = new JSObject();
                receiverInfo.put("receiverAppId", getReceiverAppId());
                diagnostics.put("receiver", receiverInfo);

                // Network connectivity (basic check)
                try {
                    android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                        getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
                    android.net.NetworkInfo activeNetwork = cm.getActiveNetworkInfo();
                    boolean isConnected = activeNetwork != null && activeNetwork.isConnected();
                    boolean isWifi = activeNetwork != null && activeNetwork.getType() == android.net.ConnectivityManager.TYPE_WIFI;

                    JSObject networkInfo = new JSObject();
                    networkInfo.put("isConnected", isConnected);
                    networkInfo.put("isWifi", isWifi);
                    if (activeNetwork != null) {
                        networkInfo.put("networkType", activeNetwork.getTypeName());
                        networkInfo.put("isConnectedOrConnecting", activeNetwork.isConnectedOrConnecting());

                        // Try to get WiFi SSID and IP address for debugging
                        try {
                            android.net.wifi.WifiManager wifiManager = (android.net.wifi.WifiManager)
                                getContext().getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);
                            if (wifiManager != null) {
                                android.net.wifi.WifiInfo wifiInfo = wifiManager.getConnectionInfo();
                                if (wifiInfo != null) {
                                    String ssid = wifiInfo.getSSID();
                                    if (ssid != null && !ssid.equals("<unknown ssid>")) {
                                        networkInfo.put("wifiSSID", ssid.replace("\"", ""));
                                    }
                                    int ipAddress = wifiInfo.getIpAddress();
                                    if (ipAddress != 0) {
                                        String ip = String.format("%d.%d.%d.%d",
                                            (ipAddress & 0xff),
                                            (ipAddress >> 8 & 0xff),
                                            (ipAddress >> 16 & 0xff),
                                            (ipAddress >> 24 & 0xff));
                                        networkInfo.put("ipAddress", ip);
                                    }
                                }
                            }
                        } catch (Exception e) {
                            Log.d(TAG, "Could not get WiFi details: " + e.getMessage());
                        }
                    }
                    diagnostics.put("network", networkInfo);
                } catch (Exception e) {
                    Log.e(TAG, "Error getting network info", e);
                    diagnostics.put("networkError", e.getMessage());
                }

                Log.d(TAG, "=== Diagnostics completed ===");
                call.resolve(diagnostics);

            } catch (Exception e) {
                Log.e(TAG, "Error in getDiagnostics", e);
                call.reject("Error getting diagnostics: " + e.getMessage());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (castContext != null) {
            castContext.removeCastStateListener(castStateListener);
        }
        if (sessionManager != null) {
            sessionManager.removeSessionManagerListener(sessionManagerListener, CastSession.class);
        }
        super.handleOnDestroy();
    }
}
