// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

/** Compile-only stand-in for bay-engine.aar's BayProfile (see README.md). */
public final class BayProfile {
    public interface ClearDataCallback {
        void onCleared(boolean complete);
    }

    private BayProfile() {}

    public static BayProfile normal() {
        throw new UnsupportedOperationException();
    }

    public static BayProfile createPrivate() {
        throw new UnsupportedOperationException();
    }

    public boolean isPrivate() {
        throw new UnsupportedOperationException();
    }

    public boolean isDestroyed() {
        throw new UnsupportedOperationException();
    }

    public void destroy() {
        throw new UnsupportedOperationException();
    }

    public void clearData(ClearDataCallback callback) {
        throw new UnsupportedOperationException();
    }
}
