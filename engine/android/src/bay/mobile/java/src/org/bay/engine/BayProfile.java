// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import org.chromium.base.ThreadUtils;
import org.jni_zero.CalledByNative;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A browsing session. The normal profile lasts as long as the app and keeps its data on disk; so does each space's
 * profile ({@link #forSpace}), apart from the normal one, as each desktop space has its own. A private profile
 * keeps everything in memory and ends when {@link #destroy} is called, which the app does once its last private tab
 * has closed: its cookies, storage and cache go with it, and the next private tab gets a new one.
 */
@JNINamespace("bay")
public final class BayProfile {
    private static BayProfile sNormal;
    private static final Map<String, BayProfile> sSpaces = new HashMap<>();
    /** A space id names a directory: letters, digits, '-' and '_', at most 64 of them. */
    private static final Pattern SPACE_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

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

    /**
     * A space's persistent profile, kept apart from the normal one and every other space's: its own cookies, storage
     * and cache. The engine must have started.
     */
    public static BayProfile forSpace(String spaceId) {
        ThreadUtils.assertOnUiThread();
        if (!SPACE_ID.matcher(spaceId).matches()) throw new IllegalArgumentException("Not a space id: " + spaceId);
        BayProfile profile = sSpaces.get(spaceId);
        if (profile == null) {
            profile = new BayProfile(BayProfileJni.get().getSpace(spaceId), false);
            sSpaces.put(spaceId, profile);
        }
        return profile;
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

    /** Whether {@link #clearData} removed everything. */
    public interface ClearDataCallback {
        void onCleared(boolean complete);
    }

    /** Removes the profile's cookies, site storage and cache. Open pages stay open, signed out. */
    public void clearData(ClearDataCallback callback) {
        ThreadUtils.assertOnUiThread();
        if (mNativeProfile == 0) {
            callback.onCleared(true);
            return;
        }
        BayProfileJni.get().clearData(mNativeProfile, callback);
    }

    @CalledByNative
    private static void onDataCleared(Object callback, boolean complete) {
        ((ClearDataCallback) callback).onCleared(complete);
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

        long getSpace(String spaceId);

        long createPrivate();

        void destroyPrivate(long profilePtr);

        void clearData(long profilePtr, Object callback);
    }
}
