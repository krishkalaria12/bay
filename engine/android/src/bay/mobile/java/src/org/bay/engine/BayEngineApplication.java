// Copyright 2026 Bay authors. Adapted from content/shell/android/shell_apk/src/org/chromium/content_shell_apk/
// ContentShellApplication.java, Copyright 2012 The Chromium Authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.app.Application;
import android.content.Context;

import org.chromium.base.ApplicationStatus;
import org.chromium.base.ContextUtils;
import org.chromium.base.PathUtils;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.base.library_loader.LibraryProcessType;
import org.chromium.net.NetworkChangeNotifier;
import org.chromium.ui.base.ResourceBundle;

/**
 * Process setup the app's {@link Application} must run. Android starts the app's Application class in every process,
 * including the engine's sandboxed renderers and its GPU process, so the app calls {@link #attachBaseContext} first
 * and skips its own startup (React Native, Expo) wherever it returns false.
 */
public final class BayEngineApplication {
    /** Data lives under the app's {@code app_bay_engine} directory. */
    private static final String DATA_DIRECTORY_SUFFIX = "bay_engine";

    private BayEngineApplication() {}

    /** Whether this is one of the engine's own child processes (their names carry a ':' suffix the engine declared). */
    public static boolean isEngineChildProcess(Context context) {
        String name = ContextUtils.getProcessName();
        return name.contains(":sandboxed_process")
                || name.contains(":privileged_process")
                || name.endsWith("_zygote");
    }

    /**
     * Call from {@code Application.attachBaseContext}, after {@code super}. Returns whether this is the app's own
     * process, where the app should carry on with its usual setup.
     */
    public static boolean attachBaseContext(Application application) {
        ContextUtils.initApplicationContext(application);
        boolean child = isEngineChildProcess(application);
        // Bay draws its own UI in its own languages: the engine's few strings are en-US, in bay_engine.pak.
        ResourceBundle.setNoAvailableLocalePaks();
        LibraryLoader.getInstance()
                .setLibraryProcessType(
                        child ? LibraryProcessType.PROCESS_CHILD : LibraryProcessType.PROCESS_BROWSER);
        if (!child) {
            PathUtils.setPrivateDataDirectorySuffix(DATA_DIRECTORY_SUFFIX);
            ApplicationStatus.initialize(application);
        }
        return !child;
    }

    /** Call from {@code Application.onCreate}, after {@code super}, in the app's own process. */
    public static void onCreate(Application application) {
        NetworkChangeNotifier.init();
        NetworkChangeNotifier.setAutoDetectConnectivityState(true);
    }
}
