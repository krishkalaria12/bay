// Settings' pieces, after Yab's (SettingsRows.swift, SettingsPageHeader.swift, SettingsIndex.swift): white cards on the
// page's grey, a section's title in small capitals over its card and its words under it, rows with a grey icon square,
// the value at the right and a chevron, a tick or a switch; the index's coloured tiles; a page's header.

import { useThemeColor } from "heroui-native";
import type { JSX, ReactNode } from "react";
import { Image, StyleSheet, View, type ViewProps } from "react-native";

import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { Toggle } from "@/chrome/Toggle";
import { iconSize, radius, rowHeight, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

import type { Tile } from "./content";
import type { SettingsPage, SettingsRow, SettingsSection } from "./model";

const BAY_MARK = require("../../assets/images/bay-mark.png");

/** A row: 16 in, 12 between its icon, words and what's at its end. */
const ROW_INSET = space.lg;
const ROW_GAP = space.md;

/** A row's grey icon square, and the index's coloured tile. */
const ICON_BOX = 28;
const INDEX_TILE = 30;
/** A page's tile over its name. */

const HERO_TILE = 56;

function Hairline({ inset }: { inset: number }): JSX.Element {
  return <View className="bg-foreground/10" style={{ height: StyleSheet.hairlineWidth, marginLeft: inset }} />;
}

/** A section: its title in small capitals, the card of rows, the words under it. */
export function Section({
  section,
  highlight,
  onLayout,
  onRowLayout,
  onOpenPage,
}: {
  section: SettingsSection;
  /** The row a search opened the page at, lit for a moment. */
  highlight?: string;
  /** Where the section starts on its page, and where each row starts in the section: the page scrolls to a row. */
  onLayout?: (y: number) => void;
  onRowLayout?: (id: string, y: number) => void;
  /** A row that opens a page. */
  onOpenPage?: (page: SettingsPage) => void;
}): JSX.Element {
  return (
    <View onLayout={(event) => onLayout?.(event.nativeEvent.layout.y)}>
      {section.title ? (
        <Text
          accessibilityRole="header"
          variant="caption"
          weight="semibold"
          tone="muted"
          style={{ textTransform: "uppercase", paddingHorizontal: space.sm, marginBottom: 6 }}
        >
          {section.title}
        </Text>
      ) : null}
      {section.rows.length ? (
        <View className="overflow-hidden bg-surface" style={{ borderRadius: radius.card }}>
          {section.rows.map((row, index) => (
            <View key={row.id} onLayout={(event) => onRowLayout?.(row.id, event.nativeEvent.layout.y)}>
              {index ? <Hairline inset={row.icon ? ROW_INSET + ICON_BOX + ROW_GAP : ROW_INSET} /> : null}
              <Row row={row} lit={highlight === row.id} onOpenPage={onOpenPage} />
            </View>
          ))}
        </View>
      ) : null}
      {section.footer ? (
        <Text testID={section.footerTestID} variant="footnote" tone="muted" style={{ paddingHorizontal: space.sm, marginTop: 6 }}>
          {section.footer}
        </Text>
      ) : null}
    </View>
  );
}

/** One row: what it is, what it is set to, and what a tap does (a chevron, a tick, a switch or nothing). */
export function Row({ row, lit = false, onOpenPage }: { row: SettingsRow; lit?: boolean; onOpenPage?: (page: SettingsPage) => void }): JSX.Element {
  const muted = useThemeColor("muted");
  const accent = useThemeColor("accent");
  const t = useT();
  const { kind } = row;
  const spoken = [row.value, row.detail].filter(Boolean).join(", ");

  const words = (
    <>
      <RowIcon icon={row.icon} />
      <View className="flex-1" style={{ gap: 1 }}>
        <Text variant="body" tone={row.danger ? "danger" : "default"}>
          {row.label}
        </Text>
        {row.detail ? (
          <Text testID={`${row.testID}-detail`} variant="subhead" tone="muted" numberOfLines={2}>
            {row.detail}
          </Text>
        ) : null}
      </View>
      {row.value ? (
        <Text testID={`${row.testID}-value`} variant="subhead" tone={row.danger ? "danger" : "muted"} numberOfLines={1} style={{ maxWidth: "45%" }}>
          {row.value}
        </Text>
      ) : null}
    </>
  );

  const style = { minHeight: rowHeight, gap: ROW_GAP, paddingHorizontal: ROW_INSET, paddingVertical: space.sm, opacity: row.disabled ? 0.4 : 1 };

  if (kind.type === "info") {
    return (
      <View testID={row.testID} accessible accessibilityLabel={row.label} accessibilityValue={{ text: spoken }} className="flex-row items-center" style={style}>
        {words}
      </View>
    );
  }

  const selected = kind.type === "choice" ? kind.selected : kind.type === "page" ? Boolean(kind.checked) : false;

  const press = () => {
    if (kind.type === "toggle") kind.set(!kind.on);
    else if (kind.type === "choice") kind.choose();
    else if (kind.type === "action") kind.run();
    else if (kind.type === "page") onOpenPage?.(kind.page);
  };

  return (
    <PressFeedback
      testID={row.testID}
      accessibilityRole={kind.type === "toggle" ? "switch" : "button"}
      accessibilityLabel={row.label}
      accessibilityState={kind.type === "toggle" ? { disabled: row.disabled, checked: kind.on } : { disabled: row.disabled, selected }}
      // Always an object: Android keeps the last value when the prop goes away.
      accessibilityValue={{ text: spoken }}
      disabled={row.disabled}
      onPress={press}
      className={lit ? "flex-row items-center bg-accent/15" : "flex-row items-center active:bg-foreground/5"}
      style={style}
    >
      {words}
      {kind.type === "toggle" ? <Toggle value={kind.on} disabled={row.disabled} /> : null}
      {selected ? (
        <View accessible accessibilityLabel={t("sheet.selected")}>
          <Icon name="tick" color={accent} size={iconSize.row} />
        </View>
      ) : null}
      {kind.type === "page" ? <Icon name="chevron" color={muted} size={iconSize.small} /> : null}
    </PressFeedback>
  );
}

/** A row's glyph in its grey square, or Bay's own icon. */
function RowIcon({ icon }: { icon: SettingsRow["icon"] }): JSX.Element | null {
  const foreground = useThemeColor("foreground");

  if (!icon) return null;

  if (icon === "mark") return <Image source={BAY_MARK} style={{ width: ICON_BOX, height: ICON_BOX, borderRadius: 7 }} accessibilityIgnoresInvertColors />;

  return (
    <View className="items-center justify-center bg-default" style={{ width: ICON_BOX, height: ICON_BOX, borderRadius: 7 }}>
      <Icon name={icon} color={foreground} size={iconSize.small} />
    </View>
  );
}

/** An index entry's tile: a white glyph on its colour, or Bay's icon; the same at a page's header, larger. */
export function SettingsTile({ tile, size = INDEX_TILE }: { tile: Tile; size?: number }): JSX.Element {
  // iOS's continuous corners, a quarter of the side.
  const corner = Math.round(size * 0.26);

  if (tile.icon === "mark") return <Image source={BAY_MARK} style={{ width: size, height: size, borderRadius: corner }} accessibilityIgnoresInvertColors />;

  return (
    <View className="items-center justify-center" style={{ width: size, height: size, borderRadius: corner, backgroundColor: tile.tint }}>
      <Icon name={tile.icon} color="#FFFFFF" size={Math.round(size * 0.58)} />
    </View>
  );
}

/** A row of the index: the entry's tile, its name, and what it is set to under the name. */
export function IndexRow({
  testID,
  tile,
  title,
  detail,
  onPress,
}: {
  testID: string;
  tile: Tile;
  title: string;
  detail?: string;
  onPress: () => void;
}): JSX.Element {
  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityValue={{ text: detail ?? "" }}
      onPress={onPress}
      className="flex-row items-center active:bg-foreground/5"
      style={{ minHeight: 50, gap: ROW_GAP, paddingHorizontal: space.md, paddingVertical: 5 }}
    >
      <SettingsTile tile={tile} />
      <View className="flex-1">
        <Text variant="body">{title}</Text>
        {detail ? (
          <Text testID={`${testID}-value`} variant="footnote" tone="muted" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </PressFeedback>
  );
}

/** A card of index rows, 4 of padding above and below them, as Yab's index has. */
export function IndexCard({ children, ...props }: ViewProps & { children: ReactNode }): JSX.Element {
  return (
    <View {...props} className="overflow-hidden bg-surface" style={{ borderRadius: radius.card, paddingVertical: space.xs }}>
      {children}
    </View>
  );
}

/** A page's header: its tile, its name and its one line, centred. */
export function PageHeader({ tile, title, blurb }: { tile: Tile | null; title: string; blurb?: string }): JSX.Element {
  return (
    <View className="items-center" style={{ gap: space.md, paddingTop: space.xs, paddingBottom: 18 }}>
      {tile ? <SettingsTile tile={tile} size={HERO_TILE} /> : null}
      <Text testID="settings-page-title" accessibilityRole="header" variant="title" className="text-center">
        {title}
      </Text>
      {blurb ? (
        <Text variant="footnote" tone="muted" className="text-center" style={{ paddingHorizontal: space.xl }}>
          {blurb}
        </Text>
      ) : null}
    </View>
  );
}
