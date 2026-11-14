// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import androidx.annotation.Nullable;

/** Compile-only stand-in for bay-engine.aar's BayDownloads (see README.md). */
public final class BayDownloads {
    public interface Listener {
        void onStarted(String id, String url, String filename, String mimeType, long total, boolean isPrivate);

        void onProgress(String id, long received, long total);

        void onFinished(String id, String path, String mimeType);

        void onFailed(String id, String message);

        void onCancelled(String id);
    }

    private BayDownloads() {}

    public static void setListener(@Nullable Listener listener) {
        throw new UnsupportedOperationException();
    }

    public static void cancel(String id) {
        throw new UnsupportedOperationException();
    }
}
