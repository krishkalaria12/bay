// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.app.Activity;
import android.graphics.Bitmap;
import android.view.View;

import androidx.annotation.Nullable;

/** Compile-only stand-in for bay-engine.aar's BayTab (see README.md). */
public final class BayTab {
    public static final int DIALOG_ALERT = 0;
    public static final int DIALOG_CONFIRM = 1;
    public static final int DIALOG_PROMPT = 2;

    public static final int PERMISSION_LOCATION = 0;
    public static final int PERMISSION_CAMERA = 1;
    public static final int PERMISSION_MICROPHONE = 2;
    public static final int PERMISSION_CAMERA_AND_MICROPHONE = 3;

    public interface EvaluationCallback {
        void onResult(String json);

        void onError(String message);
    }

    public interface SnapshotCallback {
        void onSnapshot(@Nullable Bitmap bitmap);
    }

    public BayTab(Activity activity, BayProfile profile, BayTabClient client) {
        throw new UnsupportedOperationException();
    }

    public View getView() {
        throw new UnsupportedOperationException();
    }

    public BayProfile getProfile() {
        throw new UnsupportedOperationException();
    }

    public boolean isDestroyed() {
        throw new UnsupportedOperationException();
    }

    public void loadUrl(String url) {
        throw new UnsupportedOperationException();
    }

    public void setDesktopMode(boolean desktop) {
        throw new UnsupportedOperationException();
    }

    public @Nullable String saveState() {
        throw new UnsupportedOperationException();
    }

    public boolean restoreState(String state) {
        throw new UnsupportedOperationException();
    }

    public void captureSnapshot(int maxWidth, SnapshotCallback callback) {
        throw new UnsupportedOperationException();
    }

    public void download(String url) {
        throw new UnsupportedOperationException();
    }

    public void goBack() {
        throw new UnsupportedOperationException();
    }

    public void goForward() {
        throw new UnsupportedOperationException();
    }

    public void reload() {
        throw new UnsupportedOperationException();
    }

    public void stop() {
        throw new UnsupportedOperationException();
    }

    public String getUrl() {
        throw new UnsupportedOperationException();
    }

    public String getTitle() {
        throw new UnsupportedOperationException();
    }

    public float getProgress() {
        throw new UnsupportedOperationException();
    }

    public boolean isLoading() {
        throw new UnsupportedOperationException();
    }

    public boolean canGoBack() {
        throw new UnsupportedOperationException();
    }

    public boolean canGoForward() {
        throw new UnsupportedOperationException();
    }

    public void setVisible(boolean visible) {
        throw new UnsupportedOperationException();
    }

    public void evaluate(String body, EvaluationCallback callback) {
        throw new UnsupportedOperationException();
    }

    public void answerPermission(int requestId, boolean granted) {
        throw new UnsupportedOperationException();
    }

    public void answerDialog(int requestId, boolean accepted, String text) {
        throw new UnsupportedOperationException();
    }

    public void answerHttpAuth(int requestId, boolean accepted, String username, String password) {
        throw new UnsupportedOperationException();
    }

    public void answerFileChooser(int requestId, String filesJson) {
        throw new UnsupportedOperationException();
    }

    public void exitFullscreen() {
        throw new UnsupportedOperationException();
    }

    public void destroy() {
        throw new UnsupportedOperationException();
    }
}
