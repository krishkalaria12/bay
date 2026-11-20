// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.content.Context;

import androidx.annotation.Nullable;

/** Compile-only stand-in for bay-engine.aar's BayEngine (see README.md). */
public final class BayEngine {
    public interface StartCallback {
        void onStarted();

        void onFailed();
    }

    public interface ContentBlockingCallback {
        void onApplied(boolean loaded);
    }

    private BayEngine() {}

    public static String getVersion() {
        throw new UnsupportedOperationException();
    }

    public static boolean isStarted() {
        throw new UnsupportedOperationException();
    }

    public static void start(Context context, StartCallback callback) {
        throw new UnsupportedOperationException();
    }

    public static void setContentBlocking(
            String[] files,
            String version,
            String cachePath,
            @Nullable String resourcesPath,
            ContentBlockingCallback callback) {
        throw new UnsupportedOperationException();
    }

    public static void setBlockingPausedHosts(String[] hosts) {
        throw new UnsupportedOperationException();
    }

    public static boolean setTrackingParameters(String json) {
        throw new UnsupportedOperationException();
    }

    public static @Nullable String cleanUrl(String url) {
        throw new UnsupportedOperationException();
    }
}
