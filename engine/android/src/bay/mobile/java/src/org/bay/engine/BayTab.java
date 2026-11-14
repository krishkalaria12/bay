// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.View;

import org.chromium.base.TerminationStatus;
import org.chromium.base.ThreadUtils;
import org.chromium.components.embedder_support.delegate.WebContentsDelegateAndroid;
import org.chromium.content_public.browser.GestureListenerManager;
import org.chromium.content_public.browser.GestureStateListener;
import org.chromium.content_public.browser.LoadUrlParams;
import org.chromium.content_public.browser.NavigationHandle;
import org.chromium.content_public.browser.RenderFrameHost;
import org.chromium.content_public.browser.WebContents;
import org.chromium.content_public.browser.WebContentsObserver;
import org.chromium.content_public.common.ContentUrlConstants;
import org.chromium.ui.base.PageTransition;
import org.chromium.url.GURL;
import org.jni_zero.CalledByNative;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * One page: its WebContents, its Android view, and the page's questions for the person, which go to the {@link
 * BayTabClient} and come back through the {@code answer…} methods. UI thread only.
 */
@JNINamespace("bay")
public final class BayTab extends WebContentsDelegateAndroid {
    public static final int DIALOG_ALERT = 0;
    public static final int DIALOG_CONFIRM = 1;
    public static final int DIALOG_PROMPT = 2;

    public static final int PERMISSION_LOCATION = 0;
    public static final int PERMISSION_CAMERA = 1;
    public static final int PERMISSION_MICROPHONE = 2;
    public static final int PERMISSION_CAMERA_AND_MICROPHONE = 3;

    /** A page script that hasn't answered by then is rejected. */
    private static final long EVALUATION_TIMEOUT_MS = 10_000;

    /** The result of {@link #evaluate}. */
    public interface EvaluationCallback {
        /** The script's value as JSON text ({@code null} when it returned nothing). */
        void onResult(String json);

        void onError(String message);
    }

    private long mNativeTab;
    private final BayProfile mProfile;
    private final BayTabClient mClient;
    private final WebContents mWebContents;
    private final BayTabView mView;
    private final WebContentsObserver mObserver;
    private final GestureStateListener mScrollListener;
    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private final Map<String, EvaluationCallback> mEvaluations = new HashMap<>();
    private int mNextEvaluation;
    private boolean mFullscreen;
    private float mLastScrollOffset;

    public BayTab(Activity activity, BayProfile profile, BayTabClient client) {
        ThreadUtils.assertOnUiThread();
        mProfile = profile;
        mClient = client;
        mNativeTab = BayTabJni.get().create(this, profile.nativePointer());
        mWebContents = (WebContents) BayTabJni.get().getWebContents(mNativeTab);
        mView = new BayTabView(activity, mWebContents, BayEngine.windowFor(activity), BayEngine.getVersion());
        mObserver = new Observer(mWebContents);
        mScrollListener =
                new GestureStateListener() {
                    @Override
                    public void onScrollOffsetOrExtentChanged(int scrollOffsetY, int scrollExtentY) {
                        float density = mView.getResources().getDisplayMetrics().density;
                        float offset = Math.max(0, scrollOffsetY / density);
                        mClient.onScroll(offset, offset - mLastScrollOffset);
                        mLastScrollOffset = offset;
                    }
                };
        GestureListenerManager gestures = GestureListenerManager.fromWebContents(mWebContents);
        if (gestures != null) gestures.addListener(mScrollListener);
        profile.addTab(this);
    }

    public View getView() {
        return mView;
    }

    public WebContents getWebContents() {
        return mWebContents;
    }

    public BayProfile getProfile() {
        return mProfile;
    }

    public boolean isDestroyed() {
        return mNativeTab == 0;
    }

    // Navigation -------------------------------------------------------------------------------------------------

    /** Loads an address the person typed or chose. */
    public void loadUrl(String url) {
        LoadUrlParams params = new LoadUrlParams(url, PageTransition.TYPED);
        mWebContents.getNavigationController().loadUrl(params);
    }

    public void goBack() {
        if (mWebContents.getNavigationController().canGoBack()) mWebContents.getNavigationController().goBack();
    }

    public void goForward() {
        if (mWebContents.getNavigationController().canGoForward()) {
            mWebContents.getNavigationController().goForward();
        }
    }

    public void reload() {
        mWebContents.getNavigationController().reload(/* checkForRepost= */ false);
    }

    public void stop() {
        mWebContents.stop();
    }

    public String getUrl() {
        GURL url = mWebContents.getVisibleUrl();
        return url.isEmpty() || url.getSpec().equals(ContentUrlConstants.ABOUT_BLANK_DISPLAY_URL) ? "" : url.getSpec();
    }

    public String getTitle() {
        return mWebContents.getTitle();
    }

    public float getProgress() {
        return mWebContents.getLoadProgress();
    }

    public boolean isLoading() {
        return mWebContents.isLoading();
    }

    public boolean canGoBack() {
        return mWebContents.getNavigationController().canGoBack();
    }

    public boolean canGoForward() {
        return mWebContents.getNavigationController().canGoForward();
    }

    /** A hidden tab keeps its page but stops drawing it; a playing one keeps playing. */
    public void setVisible(boolean visible) {
        mView.setPageVisible(visible);
    }

    // Page tools -------------------------------------------------------------------------------------------------

    /**
     * Runs {@code body} (the body of an async function) in Bay's isolated world of the main frame, where the page's
     * own scripts can't see it. Inside, {@code post(message)} reaches {@link BayTabClient#onPageMessage}. The result
     * belongs to this page: a navigation before it answers rejects it.
     */
    public void evaluate(String body, EvaluationCallback callback) {
        if (mNativeTab == 0) {
            callback.onError("The page is closed.");
            return;
        }
        String id = Integer.toString(++mNextEvaluation);
        String script =
                "(() => {\n"
                        + "const __bayPost = (payload) => __bayPage.postMessage(JSON.stringify(payload));\n"
                        + "const post = (message) => __bayPost({ kind: \"message\", message });\n"
                        + "(async () => {\n"
                        + body
                        + "\n})().then(\n"
                        + "(value) => __bayPost({ kind: \"result\", id: \""
                        + id
                        + "\", value: value === undefined ? null : value }),\n"
                        + "(error) => __bayPost({ kind: \"error\", id: \""
                        + id
                        + "\", message: String((error && error.message) || error) }));\n"
                        + "})();";
        if (!BayTabJni.get().evaluateInPageTools(mNativeTab, script)) {
            callback.onError("The page hasn't loaded.");
            return;
        }
        mEvaluations.put(id, callback);
        mHandler.postDelayed(() -> rejectEvaluation(id, "The page didn't answer."), EVALUATION_TIMEOUT_MS);
    }

    private void rejectEvaluation(String id, String message) {
        EvaluationCallback callback = mEvaluations.remove(id);
        if (callback != null) callback.onError(message);
    }

    private void rejectEvaluations(String message) {
        Map<String, EvaluationCallback> pending = new HashMap<>(mEvaluations);
        mEvaluations.clear();
        for (EvaluationCallback callback : pending.values()) callback.onError(message);
    }

    @CalledByNative
    private void onPageToolsMessage(String text) {
        JSONObject payload;
        try {
            payload = new JSONObject(text);
        } catch (JSONException e) {
            return;
        }
        switch (payload.optString("kind")) {
            case "message":
                Object message = payload.opt("message");
                mClient.onPageMessage(message == null ? "null" : JSONObject.wrap(message).toString());
                break;
            case "result":
                {
                    EvaluationCallback callback = mEvaluations.remove(payload.optString("id"));
                    Object value = payload.opt("value");
                    if (callback != null) {
                        callback.onResult(
                                value == null || value == JSONObject.NULL
                                        ? "null"
                                        : JSONObject.wrap(value).toString());
                    }
                    break;
                }
            case "error":
                rejectEvaluation(payload.optString("id"), payload.optString("message"));
                break;
            default:
                break;
        }
    }

    // Requests from the page -------------------------------------------------------------------------------------

    public void answerPermission(int requestId, boolean granted) {
        if (mNativeTab != 0) BayTabJni.get().answerPermission(mNativeTab, requestId, granted);
    }

    public void answerDialog(int requestId, boolean accepted, String text) {
        if (mNativeTab != 0) BayTabJni.get().answerDialog(mNativeTab, requestId, accepted, text);
    }

    public void answerHttpAuth(int requestId, boolean accepted, String username, String password) {
        if (mNativeTab != 0) {
            BayTabJni.get().answerHttpAuth(mNativeTab, requestId, accepted, username, password);
        }
    }

    /** {@code filesJson}: {@code [{"uri": "content://…", "name": "photo.jpg"}, …]}; an empty list cancels. */
    public void answerFileChooser(int requestId, String filesJson) {
        if (mNativeTab != 0) BayTabJni.get().answerFileChooser(mNativeTab, requestId, filesJson);
    }

    @CalledByNative
    private void requestPermission(int requestId, int kind, String origin) {
        mClient.onPermissionRequest(requestId, kind, origin);
    }

    @CalledByNative
    private void showJavaScriptDialog(
            int requestId, int type, String message, String defaultText, String url) {
        mClient.onJavaScriptDialog(requestId, type, message, defaultText, url);
    }

    @CalledByNative
    private void showHttpAuth(int requestId, String host, String realm) {
        mClient.onHttpAuth(requestId, host, realm);
    }

    @CalledByNative
    private void showFileChooser(int requestId, String acceptTypes, boolean multiple, boolean capture) {
        mClient.onFileChooser(requestId, acceptTypes, multiple, capture);
    }

    @CalledByNative
    private void onNewWindow(String url, boolean userGesture) {
        mClient.onNewWindow(url, userGesture);
    }

    @CalledByNative
    private void onExternalUrl(String url, boolean userGesture) {
        mClient.onExternalUrl(url, userGesture);
    }

    @CalledByNative
    private void onRequestsCancelled() {
        mClient.onRequestsCancelled();
    }

    // WebContentsDelegateAndroid ---------------------------------------------------------------------------------

    @Override
    public void navigationStateChanged(int flags) {
        mClient.onNavigationStateChanged();
    }

    @Override
    public void loadingStateChanged(boolean shouldShowLoadingUi) {
        mClient.onNavigationStateChanged();
    }

    @Override
    public void enterFullscreenModeForTab(
            RenderFrameHost renderFrameHost,
            boolean prefersNavigationBar,
            boolean prefersStatusBar,
            long displayId) {
        mFullscreen = true;
        mClient.onFullscreenChanged(true);
    }

    @Override
    public void exitFullscreenModeForTab() {
        mFullscreen = false;
        mClient.onFullscreenChanged(false);
    }

    @Override
    public boolean isFullscreenForTabOrPending() {
        return mFullscreen;
    }

    /** Leaves a page's fullscreen video (the app's Back button). */
    public void exitFullscreen() {
        if (mFullscreen) mWebContents.exitFullscreen();
    }

    // Lifetime ---------------------------------------------------------------------------------------------------

    public void destroy() {
        ThreadUtils.assertOnUiThread();
        if (mNativeTab == 0) return;
        rejectEvaluations("The page closed before the script finished.");
        mHandler.removeCallbacksAndMessages(null);
        GestureListenerManager gestures = GestureListenerManager.fromWebContents(mWebContents);
        if (gestures != null) gestures.removeListener(mScrollListener);
        mObserver.observe(null);
        mView.destroy();
        BayTabJni.get().destroy(mNativeTab);
        mNativeTab = 0;
        mProfile.removeTab(this);
    }

    private final class Observer extends WebContentsObserver {
        Observer(WebContents webContents) {
            super(webContents);
        }

        @Override
        public void didStartNavigationInPrimaryMainFrame(NavigationHandle navigation) {
            mClient.onNavigationStateChanged();
        }

        @Override
        public void didFinishNavigationInPrimaryMainFrame(NavigationHandle navigation) {
            if (navigation.isDownload()) {
                mClient.onDownloadStarted(navigation.getUrl().getSpec(), getUrl().isEmpty());
            } else if (navigation.isErrorPage()) {
                String description = navigation.errorDescription();
                String code = description == null ? "ERR_FAILED" : description.replace("net::", "");
                mClient.onMainFrameError(navigation.getUrl().getSpec(), code, description == null ? "" : description);
            }
            if (navigation.hasCommitted() && !navigation.isSameDocument()) {
                // Page tools' answers belong to the document that ran them.
                rejectEvaluations("The page changed before the script finished.");
                mLastScrollOffset = 0;
            }
            mClient.onNavigationStateChanged();
        }

        @Override
        public void loadProgressChanged(float progress) {
            mClient.onNavigationStateChanged();
        }

        @Override
        public void titleWasSet(String title) {
            mClient.onNavigationStateChanged();
        }

        @Override
        public void primaryMainFrameRenderProcessGone(int terminationStatus) {
            rejectEvaluations("The page's process ended.");
            // Killed or out of memory: the system reclaimed it. Anything else is a crash.
            mClient.onRendererGone(
                    terminationStatus != TerminationStatus.PROCESS_WAS_KILLED
                            && terminationStatus != TerminationStatus.PROCESS_WAS_KILLED_BY_OOM
                            && terminationStatus != TerminationStatus.OOM_PROTECTED);
        }
    }

    @NativeMethods
    interface Natives {
        long create(Object tab, long profilePtr);

        Object getWebContents(long tabPtr);

        void destroy(long tabPtr);

        boolean evaluateInPageTools(long tabPtr, String script);

        void answerPermission(long tabPtr, int requestId, boolean granted);

        void answerDialog(long tabPtr, int requestId, boolean accepted, String text);

        void answerHttpAuth(
                long tabPtr, int requestId, boolean accepted, String username, String password);

        void answerFileChooser(long tabPtr, int requestId, String filesJson);
    }
}
