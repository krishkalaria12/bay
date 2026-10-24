import { customBangTable, displayUrl, hostOf, joinBangTables, resolveInput, searchUrl, scopedSearchUrl, type SearchScope, type Suggestion } from "@bay/core";
import { ContextMenuArea, Symbol, copyText, showMenu } from "@bay/shell";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useTheme } from "../lib/theme";
import { useEffectEvent } from "../lib/useEffectEvent";
import { sampleOmniboxLatency, trackSuggestionChosen } from "../telemetry/track";
import { useBrowser } from "../store/browser";
import { useWindowId, useWindowSpaceId } from "../store/hooks";
import { defaultSearchEngine, searchEngines } from "../store/settings";
import { runBarAction } from "./omnibox/actions";
import { createBangSubmitter, loadBangs, mayBeBang } from "./omnibox/bangs";
import { scopeColorFor, scopeColorsFor } from "./omnibox/scopeColors";
import { traceOmnibox, useOmniboxDriver } from "./omnibox/devDriver";
import { dispositionFor, openFromBar, openInBackground, restoreFromBar, switchFromBar, type Disposition } from "./omnibox/open";
import { clipboardPasteAction, pasteMenuItem, pasteTarget, readClipboard } from "./omnibox/paste";
import { ScopeChip } from "./omnibox/ScopeChip";
import { SuggestionIcon, SuggestionList, type RowActions } from "./omnibox/SuggestionRow";
import { useDropdownStart } from "./omnibox/dropdownStart";
import { useInlineCompletion } from "./omnibox/useInlineCompletion";
import { scopeFor, useSuggestions } from "./omnibox/useSuggestions";
import { setPopover } from "./layout/pageState";
import { Favicon, IconButton } from "./primitives";
import { closeTab } from "../lib/actions";
import { PaletteContent, type PaletteMenu } from "./omnibox/PaletteContent";
import { usePaletteStart } from "./omnibox/usePaletteStart";
import { appPaletteActions } from "./omnibox/paletteAppActions";
import { forgettable, rowMenuActions } from "./omnibox/paletteRowActions";
import { currentPageActions, type PaletteSuggestion } from "./omnibox/paletteStart";
import { isEscapeKey } from "../lib/escapeKey";

type Variant = "palette" | "sidebar";
type Selection = { start: number; end: number };

// The text an arrowed-to row puts in the field, to open as is or keep editing.
function fillText(s: Suggestion | undefined, dropdown: boolean): string | null {
  if (s?.kind === "search") return s.query;
  if (s?.kind === "page") return dropdown ? s.url : s.url.replace(/^https?:\/\//, "");
  return null;
}

const BASE_KEYS = [
  { key: "Escape" },
  { key: "Enter" },
  { key: "ArrowUp" },
  { key: "ArrowDown" },
  { key: "Tab" },
  { key: "Tab", shiftKey: true },
  { key: "n", ctrlKey: true },
  { key: "p", ctrlKey: true },
  { key: "k", metaKey: true },
  { key: "K", metaKey: true },
  { key: "c", metaKey: true, shiftKey: true },
  { key: "C", metaKey: true, shiftKey: true },
  { key: "c", metaKey: true, shiftKey: true, altKey: true },
  { key: "C", metaKey: true, shiftKey: true, altKey: true },
  { key: "Enter", metaKey: true, shiftKey: true },
  { key: "Enter", metaKey: true },
  { key: "Enter", altKey: true },
  { key: "Enter", shiftKey: true },
  { key: "Enter", ctrlKey: true },
  { key: "Enter", ctrlKey: true, shiftKey: true },
  { key: "/", metaKey: true },
];
const SCOPE_KEYS = [...BASE_KEYS, { key: "Backspace" }];
const FORGET_KEYS = [...BASE_KEYS, { key: "Backspace", shiftKey: true }];

export function Omnibox({
  variant,
  tabId,
  initialText = "",
  onCancel,
  maxHeight = 560,
  width = 720,
}: {
  variant: Variant;
  tabId: string;
  initialText?: string;
  onCancel?(): void;
  maxHeight?: number;
  width?: number;
}) {
  const theme = useTheme();
  const windowId = useWindowId();
  const spaceId = useWindowSpaceId();
  const engine = useBrowser((s) => defaultSearchEngine(s.settings));
  const engines = useBrowser((s) => searchEngines(s.settings));
  const bangsEnabled = useBrowser((s) => s.settings.searchShortcutMode === "duckduckgo");
  const searchTemplates = engines.map((e) => e.url);
  const currentUrl = useBrowser((s) => s.tabs[tabId]?.url ?? "");
  const currentTitle = useBrowser((s) => s.tabs[tabId]?.customTitle || s.tabs[tabId]?.title || "");
  const currentFavicon = useBrowser((s) => s.tabs[tabId]?.favicon ?? null);
  const palette = variant === "palette";
  const newTab = useBrowser((s) => s.windowUi[windowId]?.panel.mode === "newTab");
  const [menu, setMenu] = useState<PaletteMenu | null>(null);
  const dropdown = variant === "sidebar";

  const initial = !initialText ? "" : dropdown ? initialText : initialText.replace(/^https?:\/\//, "");
  const [typed, setTyped] = useState(initial);
  const [edited, setEdited] = useState(false);
  const [suppressCompletion, setSuppressCompletion] = useState(true);
  const [selected, setSelected] = useState(palette && !newTab && !!currentUrl && initialText === currentUrl ? -1 : 0);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const scopeColor = useBrowser((s) => (!bangsEnabled ? scopeColorFor(scope, s, spaceId) : null));
  const scopeColors = scopeColorsFor(scopeColor);
  const [arrowed, setArrowed] = useState<{ typed: string; index: number; text: string } | null>(null);
  const scopeFrom = useRef("");
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(initial ? { start: 0, end: initial.length } : null);
  const selection = useRef<Selection>({ start: 0, end: typed.length });
  const input = useRef<TextInput>(null);
  const root = useRef<View>(null);
  const [bangEnter] = useState(() =>
    createBangSubmitter(async () => {
      const bundled = await loadBangs();
      const custom = customBangTable(searchEngines(useBrowser.getState().settings).filter((e) => e.custom));
      return joinBangTables([custom, bundled]);
    }),
  );
  useEffect(() => () => bangEnter.cancel(), [bangEnter, bangsEnabled, engines]);

  const { items: suggested, completion } = useSuggestions({
    text: typed,
    active: edited || !!scope,
    windowId,
    spaceId,
    currentTabId: tabId,
    currentUrl: currentUrl || undefined,
    scope,
    // The palette scrolls a longer list than the sidebar's dropdown: as yab's, every engine suggestion (Google gives
    // ten at most) right after the search row, then matching pages.
    ...(palette ? { limit: 20, remoteLimit: 10, remoteFirst: true } : {}),
  });
  const start = useDropdownStart(dropdown && !edited && !scope, tabId, spaceId);
  const idleSections = usePaletteStart(windowId, spaceId, tabId);
  const idle = !scope && (!edited || !typed.trim());
  const pageContext = palette && !newTab && !!currentUrl && initialText === currentUrl && typed === initial && !edited && !scope;
  let sections = idleSections;
  if (!idle) sections = [{ id: "results", items: suggested }];
  else if (pageContext) sections = currentPageActions({ url: currentUrl, title: currentTitle, customTitle: null });
  const items = palette ? sections.flatMap((s) => s.items) : dropdown && !edited && !scope ? start : suggested;
  const inline = useInlineCompletion(input, typed, suppressCompletion || scope ? "" : completion);
  const shownCompletion = inline.shown;
  const typedValue = typed + shownCompletion;
  const selectedIndex = Math.min(selected, items.length - 1);
  const preview = arrowed && arrowed.typed === typed && arrowed.index === selectedIndex ? arrowed.text : null;
  const value = preview ?? typedValue;
  const current: PaletteSuggestion | undefined = items[selectedIndex];
  // ⇧⌫ forgets the selected history row once it was picked from the list, not while it's the typed match.
  const canForget = palette && forgettable(current, searchTemplates) && (!edited || selectedIndex > 0);
  const canScope = !scope && edited && !!typed.trim() && !/\s/.test(typed.trim());
  const tabScope = canScope ? scopeFor(typedValue, windowId) : null;

  // Apply selection imperatively; RN macOS can restore a stale caret when its selection prop clears.
  useLayoutEffect(() => {
    if (!pendingSelection) return;
    input.current?.setSelection(pendingSelection.start, pendingSelection.end);
    selection.current = pendingSelection;
    setPendingSelection(null);
  }, [pendingSelection]);

  const reset = () => {
    bangEnter.cancel();
    setTyped("");
    setEdited(false);
    setScope(null);
    setSelected(0);
    setSuppressCompletion(true);
    selection.current = { start: 0, end: 0 };
  };

  // Another space while open (⌃1…9, ⌥⌘←/→): what was typed stays and its results are the new space's; an untouched
  // field (the old page's address) clears for the new space's start.
  const [shownSpace, setShownSpace] = useState(spaceId);
  if (shownSpace !== spaceId) {
    setShownSpace(spaceId);
    setArrowed(null);
    setSelected(0);
    if (!edited) {
      setTyped("");
      setPendingSelection({ start: 0, end: 0 });
    }
  }

  const dismiss = () => {
    bangEnter.cancel();
    onCancel?.();
  };
  const closeMenu = () => {
    setMenu(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  const go = (url: string, disposition: Disposition = "current", background = false) => {
    bangEnter.cancel();
    if (!url) return;
    if (background) return openInBackground(url, tabId);
    if (palette && newTab && disposition !== "newWindow") useBrowser.getState().submitNewTabPanel(windowId, url);
    else openFromBar(url, tabId, disposition);
  };

  const choose = (s: Suggestion | undefined, disposition: Disposition = "current", byEnter = false, background = false) => {
    bangEnter.cancel();
    // Opt-in telemetry records the suggestion kind only, never its text.
    if (s || !scope) trackSuggestionChosen(s);
    const typedSearch = !s || (byEnter && selectedIndex === 0 && (s.kind === "page" || (s.kind === "search" && !s.bang && !s.suggested)));
    if (bangsEnabled && !scope && typedSearch) {
      const text = edited ? value : initialText || value;
      if (mayBeBang(text)) {
        const fallback = s && "url" in s ? s.url : resolveInput(text, engine.url);
        const sessionId = useBrowser.getState().windowUi[windowId]?.panel.sessionId;
        bangEnter.submit(text, (url) => {
          const state = useBrowser.getState();
          const panel = state.windowUi[windowId]?.panel;
          if (!panel?.open || panel.sessionId !== sessionId || state.settings.searchShortcutMode !== "duckduckgo") return;
          go(url ?? fallback, disposition, background);
        });
        return;
      }
    }
    if (!s) {
      if (scope) return;
      const text = edited ? value : initialText || value;
      return go(resolveInput(text, engine.url), disposition, background);
    }
    switch (s.kind) {
      case "page":
        if (s.tabId) {
          if (background || (palette && newTab && disposition !== "current")) return go(s.url, disposition, background);
          switchFromBar(s.tabId, s.url, tabId, disposition);
          return;
        }
        if (s.cleanedId && disposition === "current" && restoreFromBar(s.cleanedId, tabId)) return;
        return go(s.url, disposition, background);
      case "search":
      case "create":
        return go(s.url, disposition, background);
      case "calc":
      case "emoji":
        if (s.kind === "calc" && disposition !== "current") return go(s.url, disposition, background);
        copyText(s.value);
        setTyped(s.value);
        setSuppressCompletion(true);
        setPendingSelection({ start: 0, end: s.value.length });
        return;
      case "action":
        dismiss();
        return runBarAction(s.id, windowId);
    }
  };

  const forceSearch = () => {
    const text = typed.trim();
    if (!text) return;
    go(scope ? scopedSearchUrl(scope, text, engine) : searchUrl(engine, text));
  };

  const enterScope = (next: SearchScope) => {
    scopeFrom.current = typed;
    setScope(next);
    setTyped("");
    setEdited(true);
    setSelected(0);
    setSuppressCompletion(true);
  };

  const leaveScope = (restoreText: boolean) => {
    setScope(null);
    if (restoreText) setTyped(scopeFrom.current);
    setSelected(0);
    setSuppressCompletion(true);
  };

  const move = (delta: 1 | -1) => {
    if (!items.length) return;
    // Past either end it wraps around, as the actions menu does: ↑ on the first row goes to the last.
    const next = (Math.max(selectedIndex + delta, -1) + items.length) % items.length;
    setSelected(next);
    // Arrowing through results fills the field with the row, as Chrome's omnibox. The top row is usually what was typed
    // or its inline completion, so it keeps the field as typed unless it's a page the field doesn't spell out.
    const top = items[0];
    const topFills = !shownCompletion && top?.kind === "page" && top.url !== resolveInput(typed, engine.url);
    const text = !idle && (next > 0 || topFills) ? fillText(items[next], dropdown) : null;
    setArrowed(text === null ? null : { typed, index: next, text });
    if (text !== null) setPendingSelection({ start: text.length, end: text.length });
    else if (preview !== null) setPendingSelection({ start: typed.length, end: typedValue.length });
  };

  const forget = (s: PaletteSuggestion) => {
    const { history, removeHistory } = useBrowser.getState();
    const urls = s.host ? (history[spaceId] ?? []).filter((h) => hostOf(h.url) === s.host).map((h) => h.url) : "url" in s ? [s.url] : [];
    removeHistory(spaceId, urls);
  };

  const openRowMenu = (target = current) => {
    if (!target) return;
    const title =
      target.kind === "page"
        ? target.title || displayUrl(target.url)
        : target.kind === "search"
          ? target.query
          : target.kind === "calc" || target.kind === "emoji"
            ? target.value
            : target.title;
    const actions = rowMenuActions(target, newTab, searchTemplates, {
      choose,
      openInBackground: (url) => openInBackground(url, tabId),
      copyLink: copyText,
      closeTab,
      forget,
    });
    setMenu({ side: "right", title, actions });
  };
  const openAppMenu = () => void appPaletteActions(windowId, dismiss).then((actions) => setMenu({ side: "left", title: "Bay", actions }));

  const onKeyDown = (e: { nativeEvent: { key: string; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean } }) => {
    const { key, metaKey, altKey, shiftKey, ctrlKey } = e.nativeEvent;
    bangEnter.cancel();
    if (key === "Escape") {
      if (menu) return closeMenu();
      if (scope) return leaveScope(false);
      return dismiss();
    }
    if (palette && metaKey && key.toLowerCase() === "k") return openRowMenu();
    if (palette && metaKey && key === "/") return openAppMenu();
    if (canForget && shiftKey && key === "Backspace") return forget(current!);
    if (pageContext && metaKey && shiftKey && key.toLowerCase() === "c") {
      dismiss();
      return runBarAction(altKey ? "copyUrlAsMarkdown" : "copyUrl", windowId);
    }
    if (palette && metaKey && shiftKey && key.toLowerCase() === "c" && current && "url" in current) return copyText(current.url);
    if (key === "ArrowDown" || (ctrlKey && key === "n")) return move(1);
    if (key === "ArrowUp" || (ctrlKey && key === "p")) return move(-1);
    if (key === "Tab") {
      if (shiftKey) return move(-1);
      if (tabScope) return enterScope(tabScope);
      if (shownCompletion && preview === null) {
        setTyped(value);
        setSuppressCompletion(true);
        setPendingSelection({ start: value.length, end: value.length });
        return;
      }
      return move(1);
    }
    if (key === "Backspace" && scope && !typed) return leaveScope(true);
    if (key === "Enter") {
      if (metaKey && shiftKey) return forceSearch();
      if (ctrlKey && !(bangsEnabled && mayBeBang(typed)) && !/[\s./:]/.test(typed.trim()) && typed.trim())
        return go(`https://www.${typed.trim()}.com`, shiftKey ? "newWindow" : "current");
      // ↩ already opens a new tab from the new tab panel; ⌘↩ opens it behind the current one.
      if (palette && newTab && metaKey && !altKey && !shiftKey && current && "url" in current) return choose(current, "newTab", true, true);
      if (metaKey || altKey || shiftKey) return choose(current, dispositionFor({ metaKey, altKey, shiftKey }), true);
      return choose(current, "current", true);
    }
  };

  const onContextMenu = async () => {
    const paste = await clipboardPasteAction();
    const { start, end } = selection.current;
    const hasSelection = end > start;
    const choice = await showMenu([
      ...pasteMenuItem(paste),
      ...(paste ? [{ separator: true as const }] : []),
      { id: "cut", title: "Cut", enabled: hasSelection },
      { id: "copy", title: "Copy", enabled: hasSelection },
      { id: "paste", title: "Paste", enabled: !!paste },
      { separator: true },
      { id: "selectAll", title: "Select All", enabled: !!value },
    ]);
    if (choice === "pasteAndGo" && paste) return go(pasteTarget(paste));
    if (choice === "copy" || choice === "cut") copyText(value.slice(start, end));
    if (choice === "cut" || choice === "paste") {
      bangEnter.cancel();
      const insert = choice === "paste" ? (await readClipboard()).replace(/\s*\n\s*/g, " ") : "";
      const next = value.slice(0, start) + insert + value.slice(end);
      setTyped(next);
      setEdited(true);
      setSuppressCompletion(true);
      setSelected(0);
      setPendingSelection({ start: start + insert.length, end: start + insert.length });
    }
    if (choice === "selectAll") setPendingSelection({ start: 0, end: value.length });
    input.current?.focus();
  };

  const heardAt = useRef(0);
  const keyAt = useRef(0);
  useLayoutEffect(() => {
    if (__DEV__) traceOmnibox({ bar: `${windowId}:${variant}`, typed, heard: heardAt.current, committed: Date.now() });
    if (keyAt.current) {
      sampleOmniboxLatency(Date.now() - keyAt.current);
      keyAt.current = 0;
    }
  });

  const onChangeText = (next: string) => {
    if (__DEV__) heardAt.current = Date.now();
    const change = inline.read(next);
    if (change.echo) {
      if (!change.stale) selection.current = { start: change.inline.typed.length, end: next.length };
      return;
    }
    bangEnter.cancel();
    keyAt.current = Date.now();
    setEdited(true);
    setTyped(change.typed);
    setSuppressCompletion(change.suppress || (preview !== null && next.length < preview.length));
    setSelected(0);
  };

  useOmniboxDriver(`${windowId}:${variant}`, {
    type: onChangeText,
    clear: reset,
    key: (key, mods) => onKeyDown({ nativeEvent: { key, ...mods } }),
    submit: () => choose(current, "current", true),
    measure: () => new Promise((resolve) => root.current?.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }))),
    state: () => ({
      typed,
      value,
      selection: selection.current,
      completion: shownCompletion,
      suggested: completion,
      selected: selectedIndex,
      scope,
      scopeColor,
      scopeFrom: scopeFrom.current,
      tabScope,
      items,
    }),
  });

  const leadingIcon =
    current && (typed || scope) && current.kind !== "search" ? (
      <SuggestionIcon suggestion={current} color={theme.textPrimary} />
    ) : (
      <Symbol name="magnifyingglass" size={15} weight="medium" color={theme.textPrimary} style={{ width: 18, height: 18 }} />
    );

  // Focus once the field has its frame: autoFocus hands the window's shared field editor a
  // zero-width field, and the editor then stays wider than the field (its text draws past the
  // edge and never scrolls).
  const focused = useRef(false);
  const focusOnce = () => {
    if (focused.current) return;
    focused.current = true;
    input.current?.focus();
    const { start, end } = selection.current;
    input.current?.setSelection(start, end);
  };

  const field = (
    <TextInput
      ref={input}
      onLayout={focusOnce}
      value={value}
      onSelectionChange={(e) => {
        selection.current = e.nativeEvent.selection;
      }}
      onChangeText={onChangeText}
      placeholder={scope ? `Search ${scope.name}` : palette ? "Enter a web address" : "Search or enter address"}
      placeholderTextColor={theme.placeholder}
      selectionColor={theme.selection}
      enableFocusRing={false}
      onSubmitEditing={() => choose(current, "current", true)}
      submitBehavior={palette ? "submit" : "blurAndSubmit"}
      onBlur={palette ? undefined : onCancel}
      keyDownEvents={scope && !typed ? SCOPE_KEYS : canForget ? FORGET_KEYS : BASE_KEYS}
      onKeyDown={onKeyDown}
      onKeyPress={(e) => isEscapeKey(e) && onKeyDown({ nativeEvent: { key: "Escape" } })}
      style={{
        flex: 1,
        fontSize: palette ? 20 : 14,
        color: theme.textPrimary,
        paddingVertical: 0,
      }}
    />
  );

  // Stable, so the rows (memoized) don't re-render as the bar does.
  const chooseRow = useEffectEvent((s: Suggestion) => choose(s));
  const removeRow = useEffectEvent((url: string) => useBrowser.getState().removeHistory(spaceId, [url]));
  const rowActions: RowActions = { choose: chooseRow, hover: setSelected, remove: removeRow };
  const suggestionList = (
    <SuggestionList
      items={items}
      selectedIndex={selectedIndex}
      trailing={tabScope ? `Search ${tabScope.name}  ⇥` : null}
      dropdown={dropdown}
      actions={rowActions}
      selectionColors={scopeColors}
    />
  );

  if (palette) {
    return (
      <View ref={root}>
        <PaletteContent
          pageContext={pageContext}
          leadingIcon={pageContext ? <Favicon url={currentUrl} favicon={currentFavicon} size={20} spaceId={spaceId} /> : undefined}
          field={
            <ContextMenuArea captureDescendants style={{ flex: 1 }} onContextMenu={() => void onContextMenu()}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
                {scope ? <ScopeChip scope={scope} large colors={scopeColors} /> : null}
                {field}
              </View>
            </ContextMenuArea>
          }
          sections={sections}
          selectedIndex={selectedIndex}
          current={current}
          maxHeight={maxHeight}
          width={width}
          menu={menu}
          onCloseMenu={closeMenu}
          onAppMenu={openAppMenu}
          onRowMenu={openRowMenu}
          onHover={setSelected}
          onChoose={choose}
          onSubmit={() => choose(current, "current", true)}
          selectionColors={scopeColors}
        />
      </View>
    );
  }

  if (dropdown) {
    return (
      <View ref={root}>
        <ContextMenuArea captureDescendants onContextMenu={() => void onContextMenu()}>
          <View style={{ flexDirection: "row", alignItems: "center", height: 44, paddingLeft: 13, paddingRight: 9, gap: 9 }}>
            <View style={{ width: 18, alignItems: "center" }}>{leadingIcon}</View>
            {scope && <ScopeChip scope={scope} large={false} colors={scopeColors} />}
            {field}
            {currentUrl ? (
              <IconButton
                icon="slider.horizontal.3"
                size={15}
                box={26}
                radius={7}
                color={theme.textSecondary}
                tooltip="Site Controls"
                onPress={() => {
                  onCancel?.();
                  setPopover(tabId, "siteControls");
                }}
              />
            ) : null}
          </View>
        </ContextMenuArea>
        {suggestionList}
      </View>
    );
  }

  return null;
}
