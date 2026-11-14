// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

package org.bay.engine;

import android.annotation.SuppressLint;
import android.content.Context;
import android.util.SparseArray;
import android.view.ViewStructure;
import android.view.autofill.AutofillValue;
import android.widget.FrameLayout;

import org.chromium.components.autofill.AutofillProvider;
import org.chromium.components.embedder_support.view.ContentView;
import org.chromium.components.embedder_support.view.ContentViewRenderView;
import org.chromium.content_public.browser.Visibility;
import org.chromium.content_public.browser.WebContents;
import org.chromium.ui.base.ViewAndroidDelegate;
import org.chromium.ui.base.WindowAndroid;

import java.lang.ref.WeakReference;

/**
 * A tab's Android view: the compositor surface Chromium draws the page into, under the view that takes the page's
 * touch, keyboard, accessibility and autofill. The app's own views draw over it.
 */
@SuppressLint("ViewConstructor")
final class BayTabView extends FrameLayout {
    private final WebContents mWebContents;
    private final ContentViewRenderView mRenderView;
    private final ContentView mContentView;
    private final AutofillProvider mAutofillProvider;
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
        AutofillDelegate delegate = new AutofillDelegate(mContentView);
        webContents.setDelegates(
                productVersion,
                delegate,
                mContentView,
                window,
                WebContents.createDefaultInternalsHolder());
        addView(mContentView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        mRenderView.setCurrentWebContents(webContents);
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
        mAutofillProvider.destroy();
        removeAllViews();
        mRenderView.destroy();
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
