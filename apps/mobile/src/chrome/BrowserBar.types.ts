/** Lens's floating bar: archive, search and settings on the start page and tab switcher; tabs, search and more over a page. */
export type BrowserBarProps = (
  | { mode: "start"; onArchive: () => void; onSearch: () => void; onSettings: () => void }
  | { mode: "page"; onTabs: () => void; onSearch: () => void; onMore: () => void }
) & {
  /** Dark controls over a private page. */
  privately?: boolean;
};

export interface BarButton {
  id: string;
  label: string;
  onPress: () => void;
}

export function barButtons(props: BrowserBarProps): [BarButton & { icon: "archive" | "tabs" }, BarButton, BarButton & { icon: "settings" | "more" }] {
  return props.mode === "start"
    ? [
        { id: "bar-archive", label: "Archive", icon: "archive", onPress: props.onArchive },
        { id: "bar-search", label: "Search", onPress: props.onSearch },
        { id: "bar-settings", label: "Settings", icon: "settings", onPress: props.onSettings },
      ]
    : [
        { id: "bar-tabs", label: "Tabs", icon: "tabs", onPress: props.onTabs },
        { id: "bar-search", label: "Search", onPress: props.onSearch },
        { id: "bar-more", label: "More", icon: "more", onPress: props.onMore },
      ];
}
