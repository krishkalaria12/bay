import type { JSX } from "react";

import { PanelSheetShared, type PanelSheetProps } from "./PanelSheetShared";

export type { PanelSheetProps } from "./PanelSheetShared";
export { ActionRow, Group, SectionLabel } from "./PanelSheetShared";

// Android: the shared sheet over its solid background, as before (I6 is iOS only).
export function PanelSheet(props: PanelSheetProps): JSX.Element {
  return <PanelSheetShared {...props}>{props.children}</PanelSheetShared>;
}
