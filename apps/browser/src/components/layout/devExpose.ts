import * as permissions from "../site/permissions";
import { usePages } from "./pageState";
import * as splitActions from "./splitActions";
import * as tabDrag from "./tabDrag";
import { useUrlAnchors } from "./windowLayout";
import { measureRow, useSidebarUi } from "../sidebar/state";

if (__DEV__) {
  (globalThis as { nnLayout?: unknown }).nnLayout = { pages: usePages, anchors: useUrlAnchors, sidebarUi: useSidebarUi, measureRow, toasts: splitActions.useToasts, splitActions, tabDrag, permissions };
}
