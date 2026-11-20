// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import androidx.annotation.Nullable;

import org.chromium.base.ThreadUtils;
import org.jni_zero.CalledByNative;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;

/**
 * Downloads, in every profile. The engine fetches each one itself into a file in the app's cache; the app hears of it
 * here, shows its progress and moves the finished file where the person keeps downloads. A download's id is stable
 * for its life. UI thread only.
 */
@JNINamespace("bay")
public final class BayDownloads {
    /** What the app hears of downloads, on the UI thread. */
    public interface Listener {
        /** {@code total} is -1 when the size isn't known. {@code isPrivate}: started from a private tab. */
        void onStarted(String id, String url, String filename, String mimeType, long total, boolean isPrivate);

        void onProgress(String id, long received, long total);

        /** The file is complete at {@code path}, in the app's cache. The app moves or deletes it. */
        void onFinished(String id, String path, String mimeType);

        void onFailed(String id, String message);

        void onCancelled(String id);
    }

    private static @Nullable Listener sListener;

    private BayDownloads() {}

    /** Downloads that start with no listener still run; their file stays in the cache until it is cleared. */
    public static void setListener(@Nullable Listener listener) {
        ThreadUtils.assertOnUiThread();
        sListener = listener;
    }

    public static void cancel(String id) {
        ThreadUtils.assertOnUiThread();
        BayDownloadsJni.get().cancel(id);
    }

    @CalledByNative
    private static void onStarted(
            String id, String url, String filename, String mimeType, long total, boolean isPrivate) {
        if (sListener != null) sListener.onStarted(id, url, filename, mimeType, total, isPrivate);
    }

    @CalledByNative
    private static void onProgress(String id, long received, long total) {
        if (sListener != null) sListener.onProgress(id, received, total);
    }

    @CalledByNative
    private static void onFinished(String id, String path, String mimeType) {
        if (sListener != null) sListener.onFinished(id, path, mimeType);
    }

    @CalledByNative
    private static void onFailed(String id, String message) {
        if (sListener != null) sListener.onFailed(id, message);
    }

    @CalledByNative
    private static void onCancelled(String id) {
        if (sListener != null) sListener.onCancelled(id);
    }

    @NativeMethods
    interface Natives {
        void cancel(String id);
    }
}
