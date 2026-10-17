import { layout } from "./constants";

// Comfortable preserves the existing sidebar; Compact reduces its controls together.
export const SIDEBAR_DENSITIES = {
  comfortable: { rowHeight: layout.rowHeight, iconSize: 16, pinnedHeight: layout.pinnedHeight, addressHeight: 32, toolbarAddressHeight: 30 },
  compact: { rowHeight: 30, iconSize: 14, pinnedHeight: 35, addressHeight: 30, toolbarAddressHeight: 26 },
} as const;

export const sidebarMetrics = (density: "comfortable" | "compact" | undefined) => SIDEBAR_DENSITIES[density === "compact" ? "compact" : "comfortable"];
