import * as permissions from "../site/permissions";
import { usePages } from "./pageState";
import * as splitActions from "./splitActions";
import * as tabDrag from "./tabDrag";
import { useUrlAnchors } from "./windowLayout";
import { measureRow, useSidebarUi } from "../sidebar/state";
import { openThemeEditor } from "../profiles/ThemeEditor";

if (__DEV__) {
  (globalThis as { nnLayout?: unknown }).nnLayout = { pages: usePages, anchors: useUrlAnchors, sidebarUi: useSidebarUi, measureRow, openThemeEditor, toasts: splitActions.useToasts, splitActions, tabDrag, permissions };
}
