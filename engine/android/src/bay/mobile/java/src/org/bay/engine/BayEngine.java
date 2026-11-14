// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.app.Activity;
import android.content.Context;
import android.util.SparseArray;

import androidx.annotation.Nullable;

import org.chromium.base.CommandLine;
import org.chromium.base.ThreadUtils;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.base.library_loader.LibraryProcessType;
import org.chromium.base.version_info.VersionInfo;
import org.chromium.blink.mojom.Authenticator;
import org.chromium.components.webauthn.AuthenticatorFactory;
import org.chromium.components.webauthn.WebauthnMode;
import org.chromium.components.webauthn.WebauthnModeProvider;
import org.chromium.content_public.browser.BrowserStartupController;
import org.chromium.content_public.browser.DeviceUtils;
import org.chromium.content_public.browser.InterfaceRegistrar;
import org.chromium.ui.base.ActivityWindowAndroid;
import org.chromium.ui.base.IntentRequestTracker;
import org.jni_zero.CalledByNative;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;
import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;
import java.util.WeakHashMap;

/** Bay's Chromium engine: start it once, then make {@link BayProfile}s and {@link BayTab}s. */
@JNINamespace("bay")
public final class BayEngine {
    public interface StartCallback {
        void onStarted();

        void onFailed();
    }

    public interface ContentBlockingCallback {
        /** {@code loaded}: whether the lists could be read and compiled; the previous ones stay otherwise. */
        void onApplied(boolean loaded);
    }

    private static final SparseArray<ContentBlockingCallback> sBlockingCallbacks = new SparseArray<>();
    private static int sNextBlockingRequest;

    private static boolean sStarted;
    private static boolean sStarting;
    private static final List<StartCallback> sWaiting = new ArrayList<>();
    private static final WeakHashMap<Activity, ActivityWindowAndroid> sWindows = new WeakHashMap<>();

    private BayEngine() {}

    /** The engine's Chromium version, such as 154.0.8037.58. */
    public static String getVersion() {
        return VersionInfo.getProductVersion();
    }

    public static boolean isStarted() {
        return sStarted;
    }

    /**
     * Starts the browser process (loads the native library, then brings up its threads, network service and GPU
     * process), and calls back on the UI thread. Later calls just wait for, or report, the first.
     */
    public static void start(Context context, StartCallback callback) {
        ThreadUtils.assertOnUiThread();
        if (sStarted) {
            callback.onStarted();
            return;
        }
        sWaiting.add(callback);
        if (sStarting) return;
        sStarting = true;

        if (!CommandLine.isInitialized()) CommandLine.init(null);
        // Phones get the mobile user agent and layout; tablets the desktop one, as Chrome does.
        DeviceUtils.updateDeviceSpecificUserAgentSwitch(context);
        LibraryLoader.getInstance().ensureInitialized();
        registerPasskeys();
        BrowserStartupController.getInstance()
                .startBrowserProcessesAsync(
                        LibraryProcessType.PROCESS_BROWSER,
                        /* startGpuProcess= */ true,
                        /* startMinimalBrowser= */ false,
                        /* singleProcess= */ false,
                        new BrowserStartupController.StartupCallback() {
                            @Override
                            public void onSuccess(
                                    BrowserStartupController.StartupMetrics metrics) {
                                finish(true);
                            }

                            @Override
                            public void onFailure() {
                                finish(false);
                            }
                        });
    }

    /**
     * Passkeys and security keys (WebAuthn) for every site, as a browser offers them: each frame's requests go to the
     * person's credential provider through Android's Credential Manager, naming the page's origin (the app's
     * CREDENTIAL_MANAGER_SET_ORIGIN permission). A provider answers once it lists Bay as a browser it trusts.
     */
    private static void registerPasskeys() {
        WebauthnModeProvider.getInstance().setGlobalWebauthnMode(WebauthnMode.BROWSER);
        InterfaceRegistrar.Registry.addRenderFrameHostRegistrar(
                (registry, frame) ->
                        registry.addInterface(
                                Authenticator.MANAGER,
                                new AuthenticatorFactory(frame, /* confirmationFactory= */ null)));
    }

    private static void finish(boolean started) {
        sStarting = false;
        sStarted = started;
        List<StartCallback> waiting = new ArrayList<>(sWaiting);
        sWaiting.clear();
        for (StartCallback callback : waiting) {
            if (started) {
                callback.onStarted();
            } else {
                callback.onFailed();
            }
        }
    }

    // Content blocking --------------------------------------------------------------------------------------------

    /**
     * Blocks requests in every tab with these filter list files (paths), or stops blocking with an empty list. The
     * lists are compiled off the UI thread and cached at {@code cachePath} for {@code version}, so a later launch with
     * the same version loads them at once. {@code resourcesPath} is the scriptlet and redirect resources file.
     */
    public static void setContentBlocking(
            String[] files,
            String version,
            String cachePath,
            @Nullable String resourcesPath,
            ContentBlockingCallback callback) {
        ThreadUtils.assertOnUiThread();
        int requestId = ++sNextBlockingRequest;
        sBlockingCallbacks.put(requestId, callback);
        BayEngineJni.get()
                .setContentBlocking(
                        new JSONArray(java.util.Arrays.asList(files)).toString(),
                        version,
                        cachePath,
                        resourcesPath,
                        requestId);
    }

    @CalledByNative
    private static void onContentBlockingApplied(int requestId, boolean loaded) {
        ContentBlockingCallback callback = sBlockingCallbacks.get(requestId);
        sBlockingCallbacks.remove(requestId);
        if (callback != null) callback.onApplied(loaded);
    }

    /** Sites (hosts, matching their subdomains) where blocking is paused. */
    public static void setBlockingPausedHosts(String[] hosts) {
        BayEngineJni.get().setBlockingPausedHosts(new JSONArray(java.util.Arrays.asList(hosts)).toString());
    }

    /** The tracking-parameter table navigations drop (@bay/core's TRACKING_PARAMS, as JSON). */
    public static boolean setTrackingParameters(String json) {
        return BayEngineJni.get().setTrackingParameters(json);
    }

    /** {@code url} without its tracking parameters, or null when it has none. */
    public static @Nullable String cleanUrl(String url) {
        return BayEngineJni.get().cleanUrl(url);
    }

    /** The engine's window for an activity: one per activity, shared by its tabs. */
    static ActivityWindowAndroid windowFor(Activity activity) {
        ActivityWindowAndroid window = sWindows.get(activity);
        if (window == null) {
            window =
                    new ActivityWindowAndroid(
                            activity,
                            /* listenToActivityState= */ true,
                            IntentRequestTracker.createFromActivity(activity),
                            /* insetObserver= */ null,
                            /* occlusionTrackingAllowed= */ true);
            sWindows.put(activity, window);
        }
        return window;
    }

    @NativeMethods
    interface Natives {
        void setContentBlocking(
                String filesJson,
                String version,
                String cachePath,
                @Nullable String resourcesPath,
                int requestId);

        void setBlockingPausedHosts(String hostsJson);

        boolean setTrackingParameters(String json);

        @Nullable
        String cleanUrl(String url);
    }
}
