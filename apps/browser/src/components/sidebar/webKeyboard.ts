// The sidebar's keyboard on the Chrome-hosted desktop, which has no AppKit responder (SidebarMoveUndoView in
// Menus.swift) to take keys for it. While a row has keyboard focus, or a sidebar edit can be undone, this document
// holds focus and reads the keys itself. A text field or a page keeps its keys, as on macOS.

// The keys macOS's responder gives the sidebar, by DOM key name.
const SIDEBAR_KEYS: Record<string, string> = {
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Enter: "Enter",
  " ": "Space",
  Backspace: "Backspace",
  Escape: "Escape",
  Home: "Home",
  End: "End",
};

export type WebSidebarKeyboard = {
  /** Whether a row has keyboard focus. */
  active(): boolean;
  /** A sidebar key ("ArrowDown", "Space"…) for the focused row. */
  runKey(key: string): void;
  /** Keyboard focus leaves the sidebar. */
  blur(): void;
  /** Whether Undo has a sidebar edit to take back. */
  canUndo(): boolean;
  undo(): void;
};

type Host = {
  document: Pick<Document, "activeElement" | "createElement" | "body" | "addEventListener" | "removeEventListener">;
};

/** A text field, an editor or a page: what the sidebar never takes keys from. */
export const holdsTyping = (element: Element | null): boolean =>
  !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "EMBED" || !!(element as HTMLElement).isContentEditable);

const plain = (event: KeyboardEvent) => !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
const isUndo = (event: KeyboardEvent) => event.key.toLowerCase() === "z" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;

export function startWebSidebarKeyboard(sidebar: WebSidebarKeyboard, host: Host = { document }) {
  const doc = host.document;
  // Holds focus until a row is drawn focused, so the first keys after Focus Sidebar aren't lost to the page.
  const holder = doc.createElement("div");
  holder.tabIndex = -1;
  holder.setAttribute("aria-hidden", "true");
  Object.assign(holder.style, { position: "fixed", width: "0", height: "0", overflow: "hidden", outline: "none" });
  doc.body.append(holder);
  const rows = new WeakSet<Element>();
  const owns = (element: Element | null) => !!element && (element === holder || rows.has(element));
  const take = () => {
    if (!owns(doc.activeElement)) holder.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !owns(doc.activeElement)) return;
    const key = plain(event) ? SIDEBAR_KEYS[event.key] : undefined;
    if (key && sidebar.active()) sidebar.runKey(key);
    else if (isUndo(event) && sidebar.canUndo()) sidebar.undo();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  // As on macOS, a click anywhere, or focus going somewhere else, ends keyboard focus.
  const onPointerDown = () => {
    if (sidebar.active()) sidebar.blur();
  };
  const onFocusIn = (event: FocusEvent) => {
    if (sidebar.active() && !owns(event.target as Element | null)) sidebar.blur();
  };
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focusin", onFocusIn, true);

  return {
    /** Keyboard focus came to the sidebar, or left it. */
    changed(active: boolean) {
      if (active) take();
      else if (owns(doc.activeElement)) (doc.activeElement as HTMLElement).blur();
    },
    /** A row drawn focused takes DOM focus, so a screen reader follows it. */
    focusRow(row: HTMLElement) {
      if (!sidebar.active()) return;
      rows.add(row);
      row.focus({ preventScroll: true });
    },
    /** A sidebar edit happened: Undo comes here, unless someone is typing. */
    armUndo() {
      if (!holdsTyping(doc.activeElement)) take();
    },
    stop() {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("focusin", onFocusIn, true);
      holder.remove();
    },
  };
}
