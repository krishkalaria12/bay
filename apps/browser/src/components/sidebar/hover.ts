import { useState, useSyncExternalStore } from "react";
import { markHoverProps } from "../../lib/hoverShift";
import { measureRow, setSidebarUi, sidebarUi, type Target } from "./state";
import { HOVER_HIDE_DELAY_MS, HOVER_SHOW_DELAY_MS } from "./constants";

let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let suppressed = false;

// Bumped by everything that ends or replaces a hover: a card measured for an older one never shows.
let ticket = 0;

export function suppressHover(value: boolean) {
  suppressed = value;

  if (value) dismissHover();
}

async function show(windowId: string, target: Target, mine: number) {
  const anchor = await measureRow(windowId, target.id);

  if (mine !== ticket || suppressed || !anchor || sidebarUi().iconPicker || sidebarUi().renaming) return;
  setSidebarUi({ hover: { windowId, ...target, anchor } });
}

export function hoverEnter(windowId: string, target: Target) {
  if (suppressed) return;
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  const current = sidebarUi().hover;

  if (current?.id === target.id) return;
  const mine = ++ticket;

  if (current) void show(windowId, target, mine);
  else showTimer = setTimeout(() => void show(windowId, target, mine), HOVER_SHOW_DELAY_MS);
}

export function hoverLeave() {
  ticket++;
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => setSidebarUi({ hover: null }), HOVER_HIDE_DELAY_MS);
}

export const keepHover = () => clearTimeout(hideTimer);

// Clicks, menus, drags, scrolling and profile switches: the card's anchor no longer holds.
export function dismissHover() {
  ticket++;
  clearTimeout(showTimer);
  clearTimeout(hideTimer);

  if (sidebarUi().hover) setSidebarUi({ hover: null });
}

export function useRowHover(windowId: string, target: Target | null) {
  const [hovered, setHovered] = useState(false);

  const hoverProps = markHoverProps({
    onMouseEnter: () => {
      setHovered(true);

      if (target) hoverEnter(windowId, target);
    },
    onMouseLeave: () => {
      setHovered(false);

      if (target) hoverLeave();
    },
  });

  return { hovered, hoverProps };
}

/** A row's hover, in a store of its own: the row's handlers set it, and only what reads it (useHovered) renders again.
 *  A row whose hover lived in its own state rendered all its wrappers (menus, press handling) at every hover. */
export type HoverFlag = { get(): boolean; subscribe(listener: () => void): () => void };

function hoverFlag() {
  let value = false;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set(next: boolean) {
      if (next === value) return;
      value = next;

      // oxlint-disable-next-line unicorn/no-useless-spread -- a listener can unsubscribe while this runs
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** useRowHover, with the hover in a HoverFlag rather than the caller's state. */
export function useRowHoverFlag(windowId: string, target: Target | null) {
  const [flag] = useState(hoverFlag);

  const hoverProps = markHoverProps({
    onMouseEnter: () => {
      flag.set(true);

      if (target) hoverEnter(windowId, target);
    },
    onMouseLeave: () => {
      flag.set(false);

      if (target) hoverLeave();
    },
  });

  const hover: HoverFlag = flag;

  return { hover, hoverProps };
}

export const useHovered = (flag: HoverFlag): boolean => useSyncExternalStore(flag.subscribe, flag.get, flag.get);
