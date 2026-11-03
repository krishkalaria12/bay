import { createFocusHolder } from "./focusHolder";

// The Ctrl+Tab switcher's keys on the Chrome-hosted desktop, which has no app-wide event monitor (setSwitcherCapture in
// ShellModule.swift). While it's open this document holds focus, so the modifier's release reaches it even when the
// switcher was opened from a page.

export type WebSwitcherActions = {
  move(step: 1 | -1): void;
  cancel(): void;
  commit(): void;
};

type Host = {
  document: Pick<Document, "activeElement" | "createElement" | "body" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
};

/** Whether a key event shows the switcher's modifier let go: none of Ctrl, Alt or Super is down. */
const released = (event: KeyboardEvent) => !event.ctrlKey && !event.altKey && !event.metaKey;

export function startWebSwitcherCapture(actions: WebSwitcherActions, host: Host = { document, window }) {
  const doc = host.document;
  const fromPage = doc.activeElement?.tagName === "EMBED";
  const holder = createFocusHolder(doc);
  holder.focus({ preventScroll: true });

  const onKeyDown = (event: KeyboardEvent) => {
    // The modifier went up before focus got here: the switcher commits on the next key instead.
    if (released(event)) return actions.commit();
    // Ctrl+Tab steps the switcher through the window's shortcuts.
    if (event.key === "Tab") return;
    if (event.key === "ArrowRight") actions.move(1);
    else if (event.key === "ArrowLeft") actions.move(-1);
    else if (event.key === "Escape") actions.cancel();
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (released(event)) actions.commit();
  };
  // As on macOS: a click cancels, and leaving the app commits.
  const onPointerUp = () => actions.cancel();
  const onBlur = () => actions.commit();
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("keyup", onKeyUp, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  host.window.addEventListener("blur", onBlur);

  return {
    /** Whether focus was on a page before, so it can go back to one. */
    fromPage,
    stop() {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("keyup", onKeyUp, true);
      doc.removeEventListener("pointerup", onPointerUp, true);
      host.window.removeEventListener("blur", onBlur);
      if (doc.activeElement === holder) holder.blur();
      holder.remove();
    },
  };
}
