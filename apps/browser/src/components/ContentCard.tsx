import * as tabCommands from "../runtime/tabActions";
import { View } from "@bay/platform";
import { WebView, type OpenWindowRequest, type PageEngine } from "@bay/nncore";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import Animated from "@bay/platform/motion";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { focus, switchToTab } from "../lib/actions";
import { noteFavicon } from "../lib/favicons";
import { pageFactsInCoordinator } from "../lib/pageFactOwnership";
import { isQuitting } from "../lib/native";
import { useTheme } from "../lib/theme";
import { layout } from "../lib/constants";
import { startChromeTabs } from "../lib/chromeTabs";
import { handOff, wantsPage } from "../lib/tabPages";
import { noteDiscarded, noteGone, noteReady } from "../lib/tabLifecycle";
import { clearEngineOffer, followSiteChoice, noteWebKitPage, offerWebKit, persistEngine } from "../lib/engines";
import { webviewRef, webviews } from "../lib/webviews";
import { useBrowserRead as useBrowser } from "../store/read";
import { useBrowser as legacyBrowser } from "../store/browser";
import { useActiveTabId, useSidebarOpen, useWindowId } from "../store/hooks";
import { activeTabId, engineProfile, viewTabIds, windowTabIds } from "../store/model";
import { successors } from "../store/tabs";
import { peeksLinks, shownPeek } from "../store/peeks";
import { splitOf } from "../store/splits";
import type { DeepReadonly } from "../runtime/projection";
import { tabEngine } from "../store/engines";
type SplitView = DeepReadonly<import("../store/types").SplitView>;
import { BookmarksBar, useBookmarksBarShown } from "./bookmarks/BookmarksBar";
import { BOOKMARKS_BAR_HEIGHT } from "./bookmarks/constants";
import { FindBar } from "./FindBar";
import { NO_TOOLBAR, NO_TOOLBAR_PAST_LIGHTS, splitGeometry, toolbarEndRoom, toolbarGeometry, type Rect, type ToolbarGeometry } from "./layout/geometry";
import { dismissPermissions, startPermissionPrompts } from "./site/permissions";
import { patchPage, pageOf, setBrowserId, setPopover, useFullscreenTab, usePopover } from "./layout/pageState";
import { useTabDrag } from "./layout/tabDrag";
import { OpenElsewhere, SadTab, StatusBubble } from "./layout/PaneOverlays";
import { PeekLayer, startPeeks } from "./layout/PeekLayer";
import { DropTargets, SplitDividers, SplitToast } from "./layout/SplitChrome";
import { SplitEmptyState } from "./layout/SplitEmptyState";
import { pagerFor } from "./layout/spacePager";
import { openFromPage } from "./layout/openFromPage";
import { setUrlAnchor, useAddressBarInSidebar, useSidebarOnRight, useTabLayout } from "./layout/windowLayout";
import { BlankTabSurface } from "./BlankTabSurface";
import { InternalPage } from "./pages";
import {
  AutofillPrompt,
  BlockedPopupsPrompt,
  EngineOfferPrompt,
  ExternalAppPrompt,
  PasswordPrompt,
  PermissionPrompt,
  answerExternalApp,
  shouldPromptForPopups,
  showAutofillPrompt,
  showPasswordPrompt,
} from "./site/Prompts";
import { SiteControls } from "./site/SiteControls";
import { ZoomPopover } from "./site/ZoomControls";
import { SelectionPopover } from "./site/SelectionPopover";
import { LinkPreview } from "./site/LinkPreviewCard";
import { setLinkPreview } from "./site/linkPreview";
import { copyLinkToSelection, searchSelection, setPageSelection, startSelectionTools, type PageSelection } from "./site/selection";
import { startMedia, useAutoPictureInPicture } from "./media/pip";
import { SharePicker, requestDisplayMedia } from "./media/SharePicker";
import { ShareBar } from "./media/ShareBar";
import { CastPicker } from "./media/CastPicker";
import { DeviceChooser } from "./site/DeviceChooser";
import { setNowPlaying, setPictureInPictureState } from "./media/state";
import { Toolbar } from "./Toolbar";
import { AutoHideToolbar, useToolbarMode, useToolbarMotion } from "./AutoHideToolbar";
import { noteScroll, revealToolbar } from "./layout/toolbarAutoHide";
import { NavigationOverlays } from "./layout/SwipeOverlay";
import "./layout/devExpose";
import { closeWebNotification, showWebNotification } from "../lib/webNotifications";
import { isSmallWindow } from "../store/small";
import { closeLittleBayOnEscape } from "./littleBay/actions";
import { closeThemeEditorOnEscape } from "./spaces/ThemeEditor";
import { PageLoadGlow } from "./layout/PageLoadGlow";
import { usePaneSwitch, type SwitchStyle } from "./layout/switchMotion";
import { DevBar } from "./developer/DevBar";
import { DEV_BAR_HEIGHT } from "./developer/constants";
import { DeveloperOffer } from "./developer/DeveloperOffer";
import { onDeveloperMessage, startDeveloperMode } from "./developer/devMode";
import { CaptureLayer } from "./capture/CaptureLayer";
import { closeCaptureOnEscape, onCaptureGesture, onCaptureMessage, startCaptures } from "./capture/state";
import { BoostEditor } from "./boosts/BoostEditor";
import { closeBoostEditorOnEscape, onBoostMessage } from "./boosts/editor";
import { useIsDeveloperTab } from "./developer/sites";
import { dispatchBrowserCommand, reportBrowserCommand } from "../runtime/commands";
import { closePeek, openPeek } from "../runtime/splitActions";
import { activate, closeTab, navigate } from "../runtime/tabActions";
import { browserRead, useBrowserRead } from "../store/read";

// Where the card's panes are: the active tab's (or its split's), or the full-screen tab's over everything.
function cardPanes(split: SplitView | undefined, activeId: string | undefined, fullscreenTab: string | null | undefined, width: number, height: number) {
  const full: Rect = { x: 0, y: 0, width, height };
  if (fullscreenTab) {
    // A split stays laid out under its pane in full screen: the other pane is still shown (painting, and seen by the
    // user as far as Picture in Picture and Chrome go), only covered.
    const under = split?.tabIds.includes(fullscreenTab) ? splitGeometry(split, width, height).panes : {};
    return { panes: { ...under, [fullscreenTab]: full }, dividers: [] };
  }
  if (split) return splitGeometry(split, width, height);
  return { panes: activeId ? { [activeId]: full } : {}, dividers: [] };
}

// Where the warm tabs' pages paint, off screen: each the card's size, or its place in its split.
function warmPaneRects(warm: string[], splits: SplitView[], width: number, height: number): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  for (const id of warm) out[id] = { x: 0, y: 0, width, height };
  for (const v of splits) Object.assign(out, splitGeometry(v, width, height).panes);
  return out;
}

// The tab a window shows once `leaving` goes, if another than it shows now: worked out as the drag starts, not followed.
function successorOf(windowId: string, leaving: string[]): string | undefined {
  const s = useBrowser.getState();
  const window = s.windows[windowId];
  const next = window ? successors(s, window, new Set(leaving))[window.spaceId] : undefined;
  return next && next !== activeTabId(s, windowId) ? next : undefined;
}

export function ContentCard() {
  const windowId = useWindowId();
  const activeId = useActiveTabId();
  const split = useBrowser((s) => splitOf(s, activeId));
  const fullscreenTab = useFullscreenTab(windowId);
  const sidebarOpen = useSidebarOpen();
  const tabLayout = useTabLayout();
  const addressInSidebar = useAddressBarInSidebar();
  // The sidebar on the right leaves the window buttons over the page's top-left corner, open or not.
  const sidebarRight = useSidebarOnRight();
  // Little Bay draws its own bar above the card (components/littleBay).
  const small = useBrowser((s) => isSmallWindow(s.windows[windowId]));
  const hideWhileScrolling = useBrowser((s) => s.settings.hideToolbarWhileScrolling);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const container = useRef<View>(null);
  useEffect(startPermissionPrompts, []);
  useEffect(startChromeTabs, []);
  useEffect(startMedia, []);
  useEffect(startSelectionTools, []);
  useEffect(startDeveloperMode, []);
  useEffect(startCaptures, []);
  useEffect(startPeeks, []);

  // The tabs whose page is in this window. Recomputed only when tabs change, not on every store update (page
  // progress, say).
  const mountedMemo = useRef<{ lists?: object; tabs?: object; ids: string[] }>({ ids: [] });
  const mounted = useBrowser(
    useShallow((s) => {
      const memo = mountedMemo.current;
      if (memo.lists === s.tabLists && memo.tabs === s.tabs) return memo.ids;
      const ids = windowTabIds(s, windowId).filter((id) => wantsPage(s.tabs[id]));
      mountedMemo.current = { lists: s.tabLists, tabs: s.tabs, ids };
      return ids;
    }),
  );

  const { panes, dividers } = cardPanes(split, activeId, fullscreenTab, size.width, size.height);

  // A tab switch keeps the panes it leaves on screen while the switch plays (layout/switchMotion.ts).
  const paneSwitch = usePaneSwitch(windowId, panes, !fullscreenTab);
  const framed = paneSwitch ? { ...paneSwitch.leaving, ...panes } : panes;

  useEffect(() => {
    const s = useBrowser.getState();
    for (const id of Object.keys(panes)) {
      const t = s.tabs[id];
      if (t?.url && !t.navigation && !t.adoptId) reportBrowserCommand(dispatchBrowserCommand({ method: "wakeTab", tabId: id }));
    }
  }, [panes]);

  const pagerPages = useStore(pagerFor(windowId).state, (st) => st.pages);
  // Tabs dragged where a drop takes them out of this window (outside it, or onto its page away from a split target).
  const leaving = useTabDrag((d) => (d.windowId === windowId && d.tabIds.length && (d.outside || !!(d.lifted ?? d.onPage)) ? d.tabIds : null));
  // The tab the window shows once they go, painting meanwhile. Hidden until the drop, its page had no frame to show:
  // the window showed an empty card while Chrome drew one (~90 ms, with the new window being built meanwhile).
  const successor = leaving ? successorOf(windowId, leaving) : undefined;
  // Keep adjacent profile pages painting so a swipe doesn't reveal an unpainted page, and the successor of tabs being
  // dragged out so the drop shows it at once.
  const warm = useBrowser(
    useShallow((s) => {
      const w = s.windows[windowId];
      const shown = w?.activeTabIds[w.spaceId];
      // Two spaces with one profile can remember the same favourite: its page is on screen once, in the shown one.
      const ids =
        !w || !pagerPages
          ? []
          : [...new Set(pagerPages.map((p) => (p.id === w.spaceId ? undefined : w.activeTabIds[p.id])).filter((id): id is string => !!id && id !== shown))];
      return successor && s.tabs[successor]?.windowId === windowId && !ids.includes(successor) ? [...ids, successor] : ids;
    }),
  );
  const warmSplits = useBrowser(useShallow((s) => warm.map((id) => splitOf(s, id)).filter((v): v is SplitView => !!v)));
  const warmPanes = warmPaneRects(warm, warmSplits, size.width, size.height);

  const shownMemo = useRef<{ mounted?: string[]; panes?: object; tabs?: object; keys: string[] }>({ keys: [] });
  const shown = useBrowser(
    useShallow((s) => {
      const memo = shownMemo.current;
      if (memo.mounted === mounted && memo.panes === framed && memo.tabs === s.tabs) return memo.keys;
      const keys = [...new Set([...mounted, ...Object.keys(framed)])]
        .map((id) => s.tabs[id])
        .filter((t) => !!t)
        // Keep mount order stable; reordering native subviews while tabs move can shuffle them.
        .sort((a, b) => a!.createdAt - b!.createdAt)
        // A tab whose space changed profile is another view: its page is the other engine profile's.
        .map((t) => `${t!.id}|${t!.spaceId}|${engineProfile(t!.spaceId)}`);
      shownMemo.current = { mounted, panes: framed, tabs: s.tabs, keys };
      return keys;
    }),
  );

  const geometryFor = (rect: Rect | undefined): ToolbarGeometry => {
    if (small) return NO_TOOLBAR;
    const leading = !!rect && rect.x === 0 && rect.y === 0;
    if (addressInSidebar) return (sidebarRight || !sidebarOpen) && leading ? NO_TOOLBAR_PAST_LIGHTS : NO_TOOLBAR;
    // The pane at the top right, beside a sidebar docked on the right: its toolbar's end holds the toggle.
    const trailing = !!rect && rect.y === 0 && rect.x + rect.width >= size.width - 1;
    return toolbarGeometry({
      sidebarButton: leading && tabLayout === "sidebar" && !sidebarRight,
      sidebarButtonEnd: trailing && sidebarRight,
      clearTrafficLights: leading && tabLayout === "sidebar" && (!sidebarOpen || sidebarRight),
      // The window's top right is this pane's unless a sidebar docked there or the top strip holds it.
      captionEnd: trailing && (tabLayout === "sidebar" ? !sidebarOpen || !sidebarRight : !sidebarOpen),
    });
  };

  // A link's peek over the pane of the tab it came from (layout/PeekLayer.tsx).
  const peek = useBrowser(useShallow((s) => shownPeek(s, windowId)));
  const peekRect = peek && !fullscreenTab ? panes[peek.fromId] : undefined;

  const focusedRect = activeId ? panes[activeId] : undefined;
  useEffect(() => {
    if (!origin || !focusedRect || addressInSidebar || small) return;
    const g = geometryFor(focusedRect);
    setUrlAnchor(windowId, { left: origin.x + focusedRect.x + g.urlLeft, top: origin.y + focusedRect.y, width: focusedRect.width - g.urlLeft - 12 });
  }, [origin, focusedRect?.x, focusedRect?.y, focusedRect?.width, tabLayout, sidebarOpen, sidebarRight, addressInSidebar]);

  return (
    <View
      ref={container}
      style={{ flex: 1 }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize({ width, height });
        container.current?.measureInWindow((x, y) => setOrigin({ x, y }));
      }}
    >
      {size.width > 0 &&
        shown.map((key) => {
          const tabId = key.slice(0, key.indexOf("|"));
          const rect = framed[tabId];
          return (
            <TabPane
              key={key}
              tabId={tabId}
              windowId={windowId}
              rect={rect}
              fullWidth={size.width}
              fullHeight={size.height}
              focused={tabId === activeId}
              inActiveSplit={!!split?.tabIds.includes(tabId)}
              fullscreen={tabId === fullscreenTab}
              covered={!!fullscreenTab && tabId !== fullscreenTab}
              geometry={geometryFor(rect)}
              toolbar={!addressInSidebar && !small}
              autoHide={hideWhileScrolling && tabLayout === "top" && !addressInSidebar && !small}
              small={small}
              mounted={mounted.includes(tabId)}
              warm={warmPanes[tabId]}
              leaving={!!paneSwitch?.leaving[tabId]}
              fade={paneSwitch?.fade[tabId]}
              slide={paneSwitch?.entering.includes(tabId) ? paneSwitch.slide : undefined}
            />
          );
        })}
      {split && !fullscreenTab && <SplitDividers split={split} dividers={dividers} width={size.width} height={size.height} />}
      {!fullscreenTab && <DropTargets panes={panes} origin={origin} />}
      {peek && peekRect && (
        <PeekLayer windowId={windowId} peek={peek} rect={peekRect}>
          <TabWebView key={peek.tabId} tabId={peek.tabId} visible warm={false} />
        </PeekLayer>
      )}
      <SplitToast windowId={windowId} />
    </View>
  );
}

// Memoized: the card re-renders on every switch, and a pane only needs to when its own props change.
const TabPane = memo(function TabPane({
  tabId,
  windowId,
  rect,
  fullWidth,
  fullHeight,
  focused,
  inActiveSplit,
  fullscreen,
  covered,
  geometry,
  toolbar,
  autoHide,
  small,
  mounted,
  warm,
  leaving,
  fade,
  slide,
}: {
  tabId: string;
  windowId: string;
  rect: Rect | undefined;
  fullWidth: number;
  fullHeight: number;
  focused: boolean;
  // Whether the window's shown split holds this pane (a boolean, so a split change re-renders only its panes).
  inActiveSplit: boolean;
  fullscreen: boolean;
  // Under the window's page in full screen (the other pane of its split): shown, but not drawn and not hit.
  covered: boolean;
  geometry: ToolbarGeometry;
  toolbar: boolean;
  // The toolbar hides while the page scrolls down (tabs on top, components/AutoHideToolbar.tsx).
  autoHide: boolean;
  small: boolean;
  mounted: boolean;
  warm: Rect | undefined;
  // Switched away from, shown until the switch is over (layout/switchMotion.ts): drawn, not hit.
  leaving: boolean;
  // The pane's fade and its page's settling while a switch plays.
  fade: SwitchStyle | undefined;
  slide: SwitchStyle | undefined;
}) {
  const theme = useTheme();
  const visible = !!rect;
  const isNewTab = useBrowser((s) => !s.tabs[tabId]?.url);
  const zoom = useBrowser((s) => s.tabs[tabId]?.zoom ?? 1);
  const popover = usePopover(tabId);
  const addressInSidebar = useAddressBarInSidebar();
  const sidebarOpen = useSidebarOpen();
  const newTabShown = useBrowser((s) => !!s.tabs[tabId]?.newTabHistory);
  const inSomeSplit = useBrowser((s) => !!warm && !!splitOf(s, tabId));
  const inSplit = visible ? inActiveSplit : inSomeSplit;
  const frame = rect ?? warm ?? { x: 0, y: 0, width: fullWidth, height: fullHeight };
  useEffect(() => {
    if (visible && isNewTab && !mounted) patchPage(tabId, { wasNewTab: true });
  }, [visible, isNewTab, mounted]);
  // A site in Developer Mode has its own bar over the page, in place of the toolbar (developer/DevBar.tsx).
  const devBar = useIsDeveloperTab(tabId) && !small && !fullscreen;
  const hideBar = autoHide && visible && !fullscreen && !devBar;
  const mode = useToolbarMode(tabId, windowId, hideBar);
  const bookmarksBar = useBookmarksBarShown(tabId) && !fullscreen && !inSplit && !small;
  const doc = useBrowser((s) => pageKey(s.tabs[tabId]?.url ?? ""));
  // The page placed by the toolbar's motion, shown or not, so switching tabs keeps its size.
  const autoLayout = autoHide && toolbar && !fullscreen && !devBar;
  // The page's own popovers open under the bar's end (inside a sidebar toggle there), or under the sidebar's field at
  // the page's start.
  const barEnd = 8 + toolbarEndRoom(geometry);
  // Without a toolbar, past the window buttons when they show over this pane's corner.
  const pageStart = geometry === NO_TOOLBAR_PAST_LIGHTS ? geometry.urlLeft : 8;
  const popoverSide = toolbar || devBar ? { right: barEnd } : { left: pageStart };
  const motion = useToolbarMotion({ enabled: autoLayout, mode, height: frame.height, extra: bookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0, doc });
  // A tab switched to shows its bar.
  useEffect(() => {
    if (visible) revealToolbar(tabId);
  }, [visible]);
  // A tab switched to takes the keyboard, as in Chrome: Space reaches its page (a video pauses), not the sidebar row
  // that was clicked. Not past the New Tab panel or a field being typed in (find, the address, a rename).
  useEffect(() => {
    if (!focused || !visible || isNewTab || small) return;
    const timer = setTimeout(() => {
      if (useBrowser.getState().windowUi[windowId]?.panel?.open || TextInput.State.currentlyFocusedInput()) return;
      void webviews.get(tabId)?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [focused, visible]);

  return (
    <Animated.View
      pointerEvents={visible && !covered && !leaving ? "auto" : "none"}
      onTouchStart={() => {
        if (visible && !focused) reportBrowserCommand(tabCommands.activate(tabId));
      }}
      style={[
        {
          position: "absolute",
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          borderRadius: fullscreen ? 0 : layout.cardRadius,
          overflow: "hidden",
          opacity: covered ? 0 : 1,
          backgroundColor: visible && !fullscreen ? theme.card : undefined,
        },
        fade,
      ]}
    >
      {devBar ? (
        visible ? (
          <DevBar tabId={tabId} windowId={windowId} geometry={geometry} navigation={toolbar} inSplit={inSplit} focused={focused || !inSplit} />
        ) : (
          <View style={{ height: toolbar ? layout.toolbarHeight : DEV_BAR_HEIGHT }} />
        )
      ) : !toolbar || fullscreen || autoLayout ? null : visible ? (
        <Toolbar tabId={tabId} geometry={geometry} windowId={windowId} inSplit={inSplit} focused={focused || !inSplit} />
      ) : (
        <View style={{ height: layout.toolbarHeight }} />
      )}
      {!autoLayout && bookmarksBar && <BookmarksBar tabId={tabId} placeholder={!visible} />}
      {/* The page and what sits on it; with a toolbar that hides, placed and moved by its motion (AutoHideToolbar's
          useToolbarMotion), a bookmarks bar going with it. */}
      <Animated.View style={autoLayout ? motion.groupStyle : { flex: 1 }}>
        {autoLayout && bookmarksBar && <BookmarksBar tabId={tabId} placeholder={!visible} />}
        <View style={autoLayout ? { height: motion.pageHeight } : { flex: 1 }}>
          {visible && !fullscreen && <ShareBar tabId={tabId} />}
          <Animated.View style={[{ flex: 1 }, slide]}>
            {mounted && <TabWebView tabId={tabId} visible={visible && !newTabShown && !isNewTab} warm={!!warm && !newTabShown && !isNewTab} />}
            {/* No toolbar to carry the load (the address in the sidebar, or full screen): the page's top shows it. */}
            {visible && (!toolbar || fullscreen) && !devBar && !small && !isNewTab && !newTabShown && <PageLoadGlow tabId={tabId} />}
            {visible &&
              isNewTab &&
              !small &&
              (inSplit ? <SplitEmptyState tabId={tabId} focused={focused} /> : <BlankTabSurface key={tabId} tabId={tabId} focused={focused && !covered} />)}
            {visible && <InternalPage tabId={tabId} />}
            {visible && (
              <>
                <FindBar tabId={tabId} />
                {/* Above the part of the page that's under the card's edge while the bar is shown. */}
                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, autoLayout && motion.bottomStyle]}>
                  <StatusBubble tabId={tabId} maxWidth={Math.max(160, frame.width / 2)} />
                </Animated.View>
                <SadTab tabId={tabId} />
                <OpenElsewhere tabId={tabId} windowId={windowId} />
                {/* A page's own prompts go with its page: not over the New Tab page shown in its place (Back to it). */}
                {!newTabShown && <DeveloperOffer tabId={tabId} left={pageStart} top={4} paneWidth={frame.width} />}
                {!newTabShown && <PermissionPrompt tabId={tabId} left={Math.max(8, Math.min(geometry.urlLeft, frame.width - 308))} top={4} />}
                <PasswordPrompt tabId={tabId} right={barEnd} top={4} />
                <AutofillPrompt tabId={tabId} right={barEnd} top={4} />
                {!newTabShown && <ExternalAppPrompt tabId={tabId} left={Math.max(8, Math.min(geometry.urlLeft, frame.width - 348))} top={4} />}
                {!newTabShown && <EngineOfferPrompt tabId={tabId} left={Math.max(8, Math.min(geometry.urlLeft, frame.width - 348))} top={4} />}
                {popover === "siteControls" && (!addressInSidebar || !sidebarOpen || devBar) && <SiteControls tabId={tabId} {...popoverSide} top={2} />}
                {popover === "popups" && <BlockedPopupsPrompt tabId={tabId} {...popoverSide} top={2} />}
                {popover === "zoom" && <ZoomPopover tabId={tabId} {...popoverSide} top={2} />}
                <SharePicker tabId={tabId} paneWidth={frame.width} />
                {!newTabShown && <DeviceChooser tabId={tabId} left={Math.max(8, Math.min(geometry.urlLeft, frame.width - 348))} top={4} />}
                <CastPicker tabId={tabId} paneWidth={frame.width} />
                <NavigationOverlays tabId={tabId} windowId={windowId} geometry={geometry} />
                <SelectionPopover tabId={tabId} zoom={zoom} />
                <LinkPreview tabId={tabId} zoom={zoom} />
                <CaptureLayer tabId={tabId} />
                <BoostEditor tabId={tabId} maxHeight={Math.max(240, frame.height - 20)} />
              </>
            )}
          </Animated.View>
        </View>
      </Animated.View>
      {hideBar && (
        <AutoHideToolbar tabId={tabId} geometry={geometry} windowId={windowId} inSplit={inSplit} focused={focused || !inSplit} mode={mode} motion={motion} />
      )}
    </Animated.View>
  );
});

const isBlank = (url: string) => !url || url === "about:blank";
const pageKey = (url: string) => url.replace(/#.*$/, "");
const hostOf = (url: string) => url.match(/^[a-z][\w+.-]*:\/\/([^/?#]*)/i)?.[1]?.toLowerCase() ?? "";

type TabWebViewProps = { tabId: string; visible: boolean; warm: boolean };

// The tab's page in its engine's view (store/engines.ts): moving it to the other engine mounts that one's view, which
// loads the page again.
function TabWebView(props: TabWebViewProps) {
  const engine = useBrowserRead((s) => tabEngine(s, props.tabId));
  return <EngineWebView key={engine} engine={engine} {...props} />;
}

function EngineWebView({ tabId, visible, warm, engine }: TabWebViewProps & { engine: PageEngine }) {
  const navigation = useBrowserRead((s) => s.tabs[tabId]?.navigation);
  const adoptId = useBrowserRead((s) => s.tabs[tabId]?.adoptId);
  const spaceId = useBrowserRead((s) => s.tabs[tabId]?.spaceId ?? "");
  const tab = () => browserRead.getState().tabs[tabId];
  const store = () => legacyBrowser.getState();
  // One for the view's life (its tab never changes): it keeps the handle it registered, to unregister only that.
  const [ref] = useState(() => webviewRef(tabId));
  const autoPictureInPicture = useAutoPictureInPicture(tabId, visible);
  // A pinned tab's or a favourite's: a link the user clicks to another site comes back as onPeekLink (store/peeks.ts).
  const peekLinks = useBrowserRead((s) => peeksLinks(s, tabId));

  const lastPage = useRef<string | null>(null);
  const pending = useRef<string | null>(navigation?.url ?? (adoptId ? (tab()?.url ?? null) : null));

  const seq = navigation?.seq;
  useEffect(() => {
    if (!navigation) return;
    pending.current = navigation.url;
    void webviews.get(tabId)?.loadUrl(navigation.url, { userInitiated: !!navigation.userInitiated });
  }, [seq]);
  const fromNewTab = useRef(pageOf(tabId).wasNewTab && !adoptId);
  useEffect(() => {
    persistEngine(tabId, engine);
    return () => noteGone(tabId);
  }, []);
  // This view goes while its tab keeps its page (lib/tabPages.ts): handed off before the native unmount (a layout
  // effect's cleanup runs in the commit). A tab that closed, went to sleep, changed profile or is going to one of the
  // app's own pages or to the other engine closes its page with the view.
  const mountedProfile = useRef(engineProfile(spaceId));
  useLayoutEffect(
    () => () => {
      const t = tab();
      const sameEngine = tabEngine(store(), tabId) === engine;
      if (wantsPage(t) && sameEngine && engineProfile(t.spaceId) === mountedProfile.current && !isQuitting()) handOff(tabId, mountedProfile.current);
    },
    [],
  );

  const onOpenWindow = (request: OpenWindowRequest) => {
    const t = tab();
    if (t) openFromPage(request, { windowId: t.windowId, spaceId: t.spaceId, tabId });
  };

  return (
    <WebView
      ref={ref}
      engine={engine}
      style={StyleSheet.absoluteFill}
      url={navigation?.url ?? (adoptId ? tab()?.url : undefined)}
      profile={engineProfile(spaceId)}
      adoptId={adoptId}
      transferKey={tabId}
      visible={visible}
      warm={warm}
      autoPictureInPicture={autoPictureInPicture}
      peekLinks={peekLinks}
      // The card under the page (ContentCard's background) is drawn once, by the app: a page without a background of its
      // own shows it, as on CEF. The page drawing it again darkened every transparent page.
      pageBackgroundColor="transparent"
      onReady={(browserId) => {
        setBrowserId(tabId, browserId);
        noteReady(tabId);
        if (tab()?.muted) void webviews.get(tabId)?.setMuted(true);
      }}
      onNavigationChange={({ url, title, canGoBack, canGoForward, isLoading, themeColor, themeColorSource, committedUrl }) => {
        const target = pending.current;
        // A fresh browser reports about:blank before the requested navigation commits.
        if (target !== null && isBlank(url) && !target.startsWith("about:")) {
          if (!pageFactsInCoordinator()) store().updateLive(tabId, { isLoading: true });
          return;
        }
        pending.current = null;
        // The navigated reducer keeps the page behind a New Tab page shown by Back (store/tabs.ts).
        const behindNewTab = tab()?.newTabHistory?.url === url;
        if (!pageFactsInCoordinator()) store().navigated(tabId, { url, title }, { isLoading, canGoBack, canGoForward, themeColor });
        if (behindNewTab) return;
        if (fromNewTab.current && url && !isBlank(url)) patchPage(tabId, { backToNewTab: true });
        if (engine === "webkit") noteWebKitPage(tabId, { url, title, isLoading, committedUrl: committedUrl ?? "" });
        if (lastPage.current !== null && pageKey(url) !== lastPage.current) {
          // Like Chrome's tab-modal dialogs, the open-app prompt stays within a site.
          if (pageOf(tabId).externalApp && hostOf(url) !== hostOf(lastPage.current)) answerExternalApp(tabId, false);
          dismissPermissions(tabId);
          setPopover(tabId, null);
          setPageSelection(tabId, null);
          setLinkPreview(tabId, null);
          clearEngineOffer(tabId);
          patchPage(tabId, { popups: [], passwordPrompt: null, crashed: null, status: "" });
          revealToolbar(tabId);
          if (!tab()?.peekOf) followSiteChoice(tabId, engine, url, lastPage.current);
        }
        lastPage.current = pageKey(url);
        patchPage(tabId, { themeColorSource: themeColorSource ?? null });
      }}
      onLoadError={() => {
        pending.current = null;
      }}
      onDownloadNavigation={({ committedUrl, skipped }) => {
        pending.current = null;
        const t = tab();
        if (!t) return;
        const coordinated = pageFactsInCoordinator();
        const s = browserRead.getState();
        if (!coordinated) store().updateLive(tabId, { isLoading: false });
        if (committedUrl) {
          if (!coordinated && t.url !== committedUrl) store().updateTab(tabId, { url: committedUrl });
          return;
        }
        const others = viewTabIds(s, t.windowId, t.spaceId).some((id) => id !== tabId);
        const opened = !!(t.openerId || t.adoptId) && !pageOf(tabId).wasNewTab;
        if (!skipped && opened && !s.live[tabId]?.canGoBack && others) {
          if (!coordinated) store().closeTab(tabId);
          return;
        }
        patchPage(tabId, { backToNewTab: false });
        if (!coordinated) store().updateTab(tabId, { url: "", title: "", favicon: null, newTabHistory: undefined });
      }}
      onProgress={(progress) => {
        if (!pageFactsInCoordinator()) store().updateLive(tabId, { progress });
      }}
      onZoom={({ zoom }) => {
        if (!pageFactsInCoordinator()) store().updateTab(tabId, { zoom });
      }}
      onFindResult={({ count, active }) => {
        if (!pageFactsInCoordinator()) store().setFind(tabId, { count, active });
      }}
      onFavicon={(favicon) => {
        if (!favicon || !tab()) return;
        if (!pageFactsInCoordinator()) store().faviconChanged(tabId, favicon);
        noteFavicon(tabId, favicon);
      }}
      onMedia={({ playing, muted }) => {
        if (!pageFactsInCoordinator()) store().updateLive(tabId, { playingAudio: playing });
        // A new browser can drop mute state before its first page load.
        if (tab()?.muted && !muted) void webviews.get(tabId)?.setMuted(true);
      }}
      onNowPlaying={(state) => setNowPlaying(tabId, state)}
      onPictureInPicture={(state) => setPictureInPictureState(tabId, state)}
      onDisplayMediaRequest={(request) => requestDisplayMedia(tabId, request)}
      onOpenWindow={onOpenWindow}
      onStatus={(status) => patchPage(tabId, { status })}
      onPeekLink={(url) => {
        // The engine judged it another site (Chrome's own rule); the tab stayed. A tab that has just stopped peeking
        // still gets its click: the link loads in it.
        if (!/^https?:/i.test(url)) return;
        const s = browserRead.getState();
        reportBrowserCommand(peeksLinks(s, tabId) ? openPeek(tabId, url) : navigate(tabId, url, { userInitiated: false }));
      }}
      onCrashed={(crashed) => {
        if (!isQuitting()) patchPage(tabId, { crashed, unresponsive: false, fullscreen: false, status: "" });
      }}
      onUnresponsive={() => patchPage(tabId, { unresponsive: true })}
      onResponsive={() => patchPage(tabId, { unresponsive: false })}
      onFullscreen={(fullscreen) => patchPage(tabId, { fullscreen })}
      onMediaAccess={(mediaAccess) =>
        patchPage(tabId, { mediaAccess: mediaAccess.camera || mediaAccess.microphone || mediaAccess.screen ? mediaAccess : null })
      }
      onSecurity={(security) => patchPage(tabId, { security })}
      onContentBlocked={({ count }) => patchPage(tabId, { blocked: count })}
      onPopupBlocked={(popup) => {
        const first = !pageOf(tabId).popups.length;
        patchPage(tabId, { popups: [...pageOf(tabId).popups, popup] });
        if (first) void shouldPromptForPopups(engineProfile(spaceId), popup.origin).then((ask) => ask && setPopover(tabId, "popups"));
      }}
      onPasswordPrompt={(prompt) => showPasswordPrompt(tabId, prompt)}
      onAutofillPrompt={(prompt, id) => showAutofillPrompt(tabId, prompt, id)}
      onExternalApp={(externalApp) => patchPage(tabId, { externalApp })}
      onPageFocus={() => {
        const t = tab();
        const s = browserRead.getState();
        if (t && splitOf(s, tabId) && s.windows[t.windowId]?.activeTabIds[t.spaceId] !== tabId) reportBrowserCommand(activate(tabId));
      }}
      // Engine close callbacks also fire during quit; don't remove saved-session tabs then.
      onWindowClose={() => !isQuitting() && reportBrowserCommand(closeTab(tabId))}
      onNotification={(notification) => showWebNotification(tabId, notification)}
      onCommand={({ command, text, modifiers }) => {
        if (command === "search") searchSelection(tabId, text, modifiers);
        else if (command === "copyLinkToHighlight") void copyLinkToSelection(tabId);
        else if (command === "escape") {
          // Esc in a page closes the theme editor over it; in a peek's page, the peek; in Little Bay's, Little Bay.
          const t = tab();
          if (closeCaptureOnEscape(tabId)) return;
          if (closeBoostEditorOnEscape(tabId)) return;
          if (t && closeThemeEditorOnEscape(t.windowId)) return;
          if (t?.peekOf) reportBrowserCommand(closePeek(t.windowId));
          else closeLittleBayOnEscape(tabId);
        }
      }}
      onPageMessage={(kind, data) => {
        if (kind === "selection") setPageSelection(tabId, data as PageSelection | null);
        else if (kind === "scroll") noteScroll(tabId, data);
        else if (kind === "devMode") onDeveloperMessage(tabId, data);
        else if (kind === "capture") onCaptureMessage(tabId, data);
        else if (kind === "boost") onBoostMessage(tabId, data);
        else if (kind === "linkPreview") setLinkPreview(tabId, data as { url: string; rect: { x: number; y: number; width: number; height: number } } | null);
        else if (kind === "captureGesture") onCaptureGesture(tabId, data);
        else if (kind === "drm") offerWebKit(tabId, data);
      }}
      onNotificationClose={closeWebNotification}
      onDiscarded={(url) => {
        pending.current = url;
        fromNewTab.current = false;
        patchPage(tabId, { backToNewTab: false, status: "" });
        if (!pageFactsInCoordinator()) store().updateLive(tabId, { isLoading: false, progress: 0, canGoBack: false, canGoForward: false, playingAudio: false });
        noteDiscarded(tabId);
      }}
      onActivateRequest={() => {
        const t = tab();
        if (!t) return;
        switchToTab(tabId);
        focus(t.windowId);
      }}
    />
  );
}
