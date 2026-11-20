// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.annotation.SuppressLint;
import android.content.Context;
import android.util.SparseArray;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillValue;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;

import org.chromium.components.autofill.AutofillProvider;
import org.chromium.components.embedder_support.view.ContentView;
import org.chromium.components.embedder_support.view.ContentViewRenderView;
import org.chromium.content_public.browser.Visibility;
import org.chromium.content_public.browser.WebContents;
import org.chromium.ui.base.ViewAndroidDelegate;
import org.chromium.ui.base.WindowAndroid;

import java.lang.ref.WeakReference;
import java.util.WeakHashMap;

/**
 * A tab's Android view: the compositor surface Chromium draws the page into, under the view that takes the page's
 * touch, keyboard, accessibility and autofill. The app's own views draw over it.
 *
 * <p>A window has one compositor: each surface's compositor takes the window's root layer, and since M152 Chromium
 * aborts when a second one tries (compositor_impl_android.cc, "Check failed: !root_window->GetLayer()"). So only the
 * tab on screen holds a surface; showing another tab hands the surface over, and the tab it leaves keeps its page,
 * undrawn, until it is shown again.
 */
@SuppressLint("ViewConstructor")
final class BayTabView extends FrameLayout {
    /** The tab whose surface each window's compositor draws, while it has one. */
    private static final WeakHashMap<WindowAndroid, BayTabView> sDrawing = new WeakHashMap<>();

    private final WebContents mWebContents;
    private final WindowAndroid mWindow;
    private @Nullable ContentViewRenderView mRenderView;
    private final ContentView mContentView;
    private final AutofillProvider mAutofillProvider;
    private boolean mVisible = true;

    BayTabView(Context context, WebContents webContents, WindowAndroid window, String productVersion) {
        super(context);
        mWebContents = webContents;
        mWindow = window;

        mContentView = ContentView.createContentView(context, webContents);
        AutofillDelegate delegate = new AutofillDelegate(mContentView);
        webContents.setDelegates(
                productVersion,
                delegate,
                mContentView,
                window,
                WebContents.createDefaultInternalsHolder());
        addView(mContentView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        // The first tab draws at once; a later one waits until it is shown (showPage), so tabs restored in the
        // background don't take the surface from the one on screen.
        if (sDrawing.get(window) == null) showPage();
        // Android Autofill (the person's password manager, or another autofill service): the content view is the
        // container the framework asks for the page's forms, through the delegate, as WebView's view is. Marked
        // important, so the app's own views around it never hide the page from the service.
        mContentView.setImportantForAutofill(IMPORTANT_FOR_AUTOFILL_YES);
        mAutofillProvider =
                new AutofillProvider(new WeakReference<>(context), mContentView, webContents, "Bay");
        delegate.mAutofillProvider = mAutofillProvider;
    }

    ContentView getContentView() {
        return mContentView;
    }

    /** Puts this tab's page on the window's compositor, taking the surface from the tab that had it. */
    void showPage() {
        if (mRenderView != null) return;
        BayTabView drawing = sDrawing.get(mWindow);
        if (drawing != null) drawing.releaseSurface();

        ContentViewRenderView renderView = new ContentViewRenderView(getContext());
        renderView.onNativeLibraryLoaded(mWindow);
        // ContentViewRenderView raises its surface over the window for video overlays; Bay's toolbar and sheets
        // draw over the page, so the surface stays under the window like any SurfaceView.
        renderView.getSurfaceView().setZOrderMediaOverlay(false);
        renderView.setVisibility(mVisible ? VISIBLE : INVISIBLE);
        // Under the content view, which takes the page's touch.
        addView(renderView, 0, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        renderView.setCurrentWebContents(mWebContents);
        mRenderView = renderView;
        sDrawing.put(mWindow, this);
    }

    /** Gives the window's compositor back: the page stays loaded, undrawn, until the tab is shown again. */
    private void releaseSurface() {
        ContentViewRenderView renderView = mRenderView;
        if (renderView == null) return;
        mRenderView = null;
        if (sDrawing.get(mWindow) == this) sDrawing.remove(mWindow);
        removeView(renderView);
        renderView.destroy();
    }

    /** A hidden tab keeps its page but stops drawing it, and its timers slow as Chrome's background tabs' do. */
    void setPageVisible(boolean visible) {
        if (mVisible == visible) return;
        mVisible = visible;
        mWebContents.updateWebContentsVisibility(visible ? Visibility.VISIBLE : Visibility.HIDDEN);
        if (mRenderView != null) mRenderView.setVisibility(visible ? VISIBLE : INVISIBLE);
    }

    /**
     * The page's SurfaceView asks the window to leave its area transparent, so the compositor skips the window there.
     * That region is worked out from the views over the page at one layout and can go stale: on some phones (a OnePlus
     * on Android 15) a band the switcher's views didn't cover stayed transparent, and the page showed through Bay's
     * sheets and bar there as a white strip. Not asked for, the window is always composited; the page still shows
     * through the hole the SurfaceView punches wherever Bay draws nothing.
     */
    @Override
    public void requestTransparentRegion(View child) {}

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (mVisible) mWebContents.updateWebContentsVisibility(Visibility.VISIBLE);
    }

    void destroy() {
        mAutofillProvider.destroy();
        releaseSurface();
        removeAllViews();
    }

    /** Answers the framework's autofill calls on the content view with the page's forms. */
    private static final class AutofillDelegate extends ViewAndroidDelegate {
        AutofillProvider mAutofillProvider;

        AutofillDelegate(ContentView containerView) {
            super(containerView);
        }

        @Override
        public boolean providesAutofillStructure() {
            return mAutofillProvider != null;
        }

        @Override
        public void onProvideAutofillVirtualStructure(ViewStructure structure, int flags) {
            if (mAutofillProvider != null) mAutofillProvider.onProvideAutoFillVirtualStructure(structure, flags);
        }

        @Override
        public void autofill(SparseArray<AutofillValue> values) {
            if (mAutofillProvider != null) mAutofillProvider.autofill(values);
        }
    }
}
