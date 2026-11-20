// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.app.Application;
import android.content.Context;

/** Compile-only stand-in for bay-engine.aar's BayEngineApplication (see README.md). */
public final class BayEngineApplication {
    private BayEngineApplication() {}

    public static boolean isEngineChildProcess(Context context) {
        throw new UnsupportedOperationException();
    }

    public static boolean attachBaseContext(Application application) {
        throw new UnsupportedOperationException();
    }

    public static void onCreate(Application application) {
        throw new UnsupportedOperationException();
    }
}
