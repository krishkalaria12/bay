import { memo, type ComponentType, type NamedExoticComponent } from "react";

/**
 * A sheet that sits out its screen's renders while it is closed and stays closed. The browser screen keeps every sheet
 * mounted (a bottom sheet can only open once it has laid out) and renders on each page load, tab change and keystroke;
 * a closed sheet can't be seen or touched, so the props it would get then don't matter. It renders again with the
 * newest ones as it opens, and once as it closes, to start dropping away; its own state still renders it any time.
 * The React Compiler can't know this: a closed sheet's callbacks change with the screen's state like an open one's.
 */
export function quietWhileClosed<P extends { visible: boolean }>(sheet: ComponentType<P>): NamedExoticComponent<P> {
  return memo(sheet, (before, after) => !before.visible && !after.visible);
}
