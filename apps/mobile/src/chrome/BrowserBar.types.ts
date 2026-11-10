import type { useAnimatedStyle } from "react-native-reanimated";

/** The search capsule's motion while the bar is swiped to change tabs (TabSwipe). */
export type CapsuleStyle = ReturnType<typeof useAnimatedStyle>;

/** Lens's floating bar: archive, search and settings on the start page and tab switcher; tabs, search and more over a page. */
export type BrowserBarProps = (
  | {
      mode: "start";
      onArchive: () => void;
      onSearch: () => void;
      onSettings: () => void;
      /** Over the tab switcher, the capsule opens a new tab and says so. */
      newTab?: boolean;
    }
  | {
      mode: "page";
      onTabs: () => void;
      /** Long-pressing Tabs offers new, private and close actions. */
      onTabsLongPress?: () => void;
      /** Dragging up on Tabs returns to the tab that was open before this one. */
      onTabsSwipeUp?: () => void;
      onSearch: () => void;
      onMore: () => void;
      /** Long-pressing More shares the page. */
      onMoreLongPress?: () => void;
      /** The page's site, shown in the search capsule. */
      site?: string;
      /** Open tabs, shown on the Tabs button. */
      tabCount?: number;
      /** The page came over plain http. */
      insecure?: boolean;
      /** How far the page has loaded, for the capsule's progress line (A6). */
      progress?: number;
      /** Whether the page is still loading, for the capsule's progress line (A6). */
      loading?: boolean;
    }
) & {
  /** Dark controls over a private page. */
  privately?: boolean;
  capsuleStyle?: CapsuleStyle;
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

/** The capsule reads "New tab" over the tab switcher. */
export function barNewTab(props: BrowserBarProps): boolean {
  return props.mode === "start" && props.newTab === true;
}

/** A page loaded without encryption gets a warning in the capsule. */
export function barInsecure(props: BrowserBarProps): boolean {
  return props.mode === "page" && Boolean(props.site) && props.insecure === true;
}

/** How far the page has loaded, for the capsule's progress line (A6). */
export function barProgress(props: BrowserBarProps): number {
  return props.mode === "page" ? (props.progress ?? 0) : 0;
}

/** Whether the page is still loading, for the capsule's progress line (A6). */
export function barLoading(props: BrowserBarProps): boolean {
  return props.mode === "page" && props.loading === true;
}

export function barButtons(props: BrowserBarProps): [BarButton & { icon: "archive" | "tabs" }, BarButton, BarButton & { icon: "settings" | "more" }] {
  return props.mode === "start"
    ? [
        { id: "bar-archive", label: "Archive", icon: "archive", onPress: props.onArchive },
        { id: "bar-search", label: props.newTab ? "New tab" : "Search", onPress: props.onSearch },
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
        {
          id: "bar-search",
          label: props.site ? `Search or enter address, ${props.insecure ? "not secure, " : ""}${props.site}` : "Search",
          onPress: props.onSearch,
        },
        { id: "bar-more", label: "More", icon: "more", onPress: props.onMore, onLongPress: props.onMoreLongPress },
      ];
}
