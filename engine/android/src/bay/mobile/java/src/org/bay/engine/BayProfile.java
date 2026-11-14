// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import org.chromium.base.ThreadUtils;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;

import java.util.HashSet;
import java.util.Set;

/**
 * A browsing session. The normal profile lasts as long as the app and keeps its data on disk. A private profile
 * keeps everything in memory and ends when {@link #destroy} is called, which the app does once its last private tab
 * has closed: its cookies, storage and cache go with it, and the next private tab gets a new one.
 */
@JNINamespace("bay")
public final class BayProfile {
    private static BayProfile sNormal;

    private long mNativeProfile;
    private final boolean mPrivate;
    private final Set<BayTab> mTabs = new HashSet<>();

    private BayProfile(long nativeProfile, boolean isPrivate) {
        mNativeProfile = nativeProfile;
        mPrivate = isPrivate;
    }

    /** The persistent profile. The engine must have started. */
    public static BayProfile normal() {
        ThreadUtils.assertOnUiThread();
        if (sNormal == null) sNormal = new BayProfile(BayProfileJni.get().getNormal(), false);
        return sNormal;
    }

    /** A new private session. The engine must have started. */
    public static BayProfile createPrivate() {
        ThreadUtils.assertOnUiThread();
        return new BayProfile(BayProfileJni.get().createPrivate(), true);
    }

    public boolean isPrivate() {
        return mPrivate;
    }

    public boolean isDestroyed() {
        return mNativeProfile == 0;
    }

    /** Ends a private session. Its open tabs are closed first. The normal profile can't be destroyed. */
    public void destroy() {
        ThreadUtils.assertOnUiThread();
        if (!mPrivate || mNativeProfile == 0) return;
        for (BayTab tab : new HashSet<>(mTabs)) tab.destroy();
        BayProfileJni.get().destroyPrivate(mNativeProfile);
        mNativeProfile = 0;
    }

    long nativePointer() {
        if (mNativeProfile == 0) throw new IllegalStateException("The profile was destroyed.");
        return mNativeProfile;
    }

    void addTab(BayTab tab) {
        mTabs.add(tab);
    }

    void removeTab(BayTab tab) {
        mTabs.remove(tab);
    }

    @NativeMethods
    interface Natives {
        long getNormal();

        long createPrivate();

        void destroyPrivate(long profilePtr);
    }
}
