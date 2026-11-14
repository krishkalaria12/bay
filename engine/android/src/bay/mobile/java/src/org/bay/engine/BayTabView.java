// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.annotation.SuppressLint;
import android.content.Context;
import android.widget.FrameLayout;

import org.chromium.components.embedder_support.view.ContentView;
import org.chromium.components.embedder_support.view.ContentViewRenderView;
import org.chromium.content_public.browser.Visibility;
import org.chromium.content_public.browser.WebContents;
import org.chromium.ui.base.ViewAndroidDelegate;
import org.chromium.ui.base.WindowAndroid;

/**
 * A tab's Android view: the compositor surface Chromium draws the page into, under the view that takes the page's
 * touch, keyboard and accessibility. The app's own views draw over it.
 */
@SuppressLint("ViewConstructor")
final class BayTabView extends FrameLayout {
    private final WebContents mWebContents;
    private final ContentViewRenderView mRenderView;
    private final ContentView mContentView;
    private boolean mVisible = true;

    BayTabView(Context context, WebContents webContents, WindowAndroid window, String productVersion) {
        super(context);
        mWebContents = webContents;
        mRenderView = new ContentViewRenderView(context);
        mRenderView.onNativeLibraryLoaded(window);
        // ContentViewRenderView raises its surface over the window for video overlays; Bay's toolbar and sheets
        // draw over the page, so the surface stays under the window like any SurfaceView.
        mRenderView.getSurfaceView().setZOrderMediaOverlay(false);
        addView(mRenderView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        mContentView = ContentView.createContentView(context, webContents);
        webContents.setDelegates(
                productVersion,
                ViewAndroidDelegate.createBasicDelegate(mContentView),
                mContentView,
                window,
                WebContents.createDefaultInternalsHolder());
        addView(mContentView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        mRenderView.setCurrentWebContents(webContents);
    }

    ContentView getContentView() {
        return mContentView;
    }

    /** A hidden tab keeps its page but stops drawing it, and its timers slow as Chrome's background tabs' do. */
    void setPageVisible(boolean visible) {
        if (mVisible == visible) return;
        mVisible = visible;
        mWebContents.updateWebContentsVisibility(visible ? Visibility.VISIBLE : Visibility.HIDDEN);
        mRenderView.setVisibility(visible ? VISIBLE : INVISIBLE);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (mVisible) mWebContents.updateWebContentsVisibility(Visibility.VISIBLE);
    }

    void destroy() {
        removeAllViews();
        mRenderView.destroy();
    }
}
