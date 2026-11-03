import * as permissions from "../site/permissions";
import { usePages } from "./pageState";
import * as splitActions from "../split/splitActions";
import * as tabDrag from "../tabStrip/tabStripDrag";
import { useUrlAnchors } from "./layout";
import { measureRow, useSidebarUi } from "../sidebar/state";
import { openThemeEditor } from "../spaces/ThemeEditor";

if (__DEV__) {
  (globalThis as { nnLayout?: unknown }).nnLayout = {
    pages: usePages,
    anchors: useUrlAnchors,
    sidebarUi: useSidebarUi,
    measureRow,
    openThemeEditor,
    toasts: splitActions.useToasts,
    splitActions,
    tabDrag,
    permissions,
  };
}
