/** Lens's floating bar: archive, search and settings on the start page and tab switcher; tabs, search and more over a page. */
export type BrowserBarProps = (
  | { mode: "start"; onArchive: () => void; onSearch: () => void; onSettings: () => void }
  | {
      mode: "page";
      onTabs: () => void;
      /** Long-pressing Tabs offers new, private and close actions. */
      onTabsLongPress?: () => void;
      onSearch: () => void;
      onMore: () => void;
      /** The page's site, shown in the search capsule. */
      site?: string;
      /** Open tabs, shown on the Tabs button. */
      tabCount?: number;
    }
) & {
  /** Dark controls over a private page. */
  privately?: boolean;
};

export interface BarButton {
  id: string;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  /** A count on the button's corner. */
  badge?: number;
}

/** The capsule's text over a page: the host without "www.". */
export function barSite(props: BrowserBarProps): string | undefined {
  return props.mode === "page" && props.site ? props.site.replace(/^www\./, "") : undefined;
}

export function barButtons(props: BrowserBarProps): [BarButton & { icon: "archive" | "tabs" }, BarButton, BarButton & { icon: "settings" | "more" }] {
  return props.mode === "start"
    ? [
        { id: "bar-archive", label: "Archive", icon: "archive", onPress: props.onArchive },
        { id: "bar-search", label: "Search", onPress: props.onSearch },
        { id: "bar-settings", label: "Settings", icon: "settings", onPress: props.onSettings },
      ]
    : [
        {
          id: "bar-tabs",
          label: props.tabCount && props.tabCount > 1 ? `Tabs, ${props.tabCount} open` : "Tabs",
          icon: "tabs",
          onPress: props.onTabs,
          onLongPress: props.onTabsLongPress,
          badge: props.tabCount,
        },
        { id: "bar-search", label: props.site ? `Search or enter address, ${props.site}` : "Search", onPress: props.onSearch },
        { id: "bar-more", label: "More", icon: "more", onPress: props.onMore },
      ];
}
