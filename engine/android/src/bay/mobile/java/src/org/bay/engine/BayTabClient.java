// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

/**
 * What a {@link BayTab} tells the app, on the UI thread. Requests carry an id: answer each with the matching {@code
 * answer…} call on the tab. {@link #onRequestsCancelled} means every open request was answered as declined (its page
 * went away), so the app should close whatever it shows for them.
 */
public interface BayTabClient {
    /** URL, title, progress, loading or back/forward changed: read them from the tab. */
    void onNavigationStateChanged();

    /** The main frame failed to load. {@code code} is Chromium's net error name, such as {@code ERR_NAME_NOT_RESOLVED}. */
    void onMainFrameError(String url, String code, String description);

    /** A navigation became a download. {@code blank} when the tab had no page before it. */
    void onDownloadStarted(String url, boolean blank);

    /** A page tool's {@code post(message)}, as JSON text. */
    void onPageMessage(String json);

    /** A new window the page opened ({@code target=_blank}, {@code window.open}), for a new tab in the same session. */
    void onNewWindow(String url, boolean userGesture);

    /** {@code type}: {@link BayTab#DIALOG_ALERT}, {@link BayTab#DIALOG_CONFIRM} or {@link BayTab#DIALOG_PROMPT}. */
    void onJavaScriptDialog(int requestId, int type, String message, String defaultText, String url);

    /** The server asks for a username and password. */
    void onHttpAuth(int requestId, String host, String realm);

    /** {@code kind}: one of {@link BayTab}'s {@code PERMISSION_…} values. The app also asks Android before granting. */
    void onPermissionRequest(int requestId, int kind, String origin);

    /** An {@code <input type=file>}. {@code acceptTypes} is the comma-separated accept list. */
    void onFileChooser(int requestId, String acceptTypes, boolean multiple, boolean capture);

    /** A link to another app (tel:, mailto:, intent:, an app's scheme). The page stays where it is. */
    void onExternalUrl(String url, boolean userGesture);

    void onRequestsCancelled();

    void onFullscreenChanged(boolean fullscreen);

    /** The page's renderer process ended. {@code crashed} is false when the system reclaimed it for memory. */
    void onRendererGone(boolean crashed);

    /** Vertical scroll, in CSS pixels. */
    void onScroll(float offsetY, float deltaY);
}
