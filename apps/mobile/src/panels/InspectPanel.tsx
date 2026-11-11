import type { JSX } from "react";
import { Platform, Pressable, View } from "react-native";

import { useT, type Translate } from "@/i18n";
import type { InspectedElement, InspectedFont } from "@/pagescripts/inspect";

import { PanelSheet, SectionLabel } from "./PanelSheet";
import { Text } from "@/chrome/Text";
import { radius } from "@/chrome/tokens";

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

export interface InspectPanelProps {
  element: InspectedElement | null;
  /** The picked element in words (Link “Pricing”). */
  title?: string;
  onClose: () => void;
  onParent: () => void;
  onCopy: () => void;
}

/** What the picked element is: its font first (the font identifier), then size, colours and the CSS that matches. */
export function InspectPanel({ element, title, onClose, onParent, onCopy }: InspectPanelProps): JSX.Element {
  const font = element?.font;
  const t = useT();

  return (
    <PanelSheet visible={element !== null} onClose={onClose} title={t("inspect.title")} testID="inspect-panel" height="62%">
      {element && font ? (
        <>
          {title ? (
            <Text testID="inspect-title" numberOfLines={2} accessibilityRole="header" variant="headline" className="mb-1">
              {title}
            </Text>
          ) : null}
          <View className="flex-row items-baseline justify-between gap-3">
            <Text
              testID="inspect-name"
              numberOfLines={1}
              variant={title ? "subhead" : "body"}
              weight={title ? undefined : "semibold"}
              tone={title ? "muted" : "default"}
              className="flex-1"
              style={{ fontFamily: MONOSPACE }}
            >
              {element.name}
            </Text>
            <Text testID="inspect-size" variant="subhead" tone="muted">
              {Math.round(element.width)} × {Math.round(element.height)}
            </Text>
          </View>
          <View className="mt-3 flex-row gap-2">
            <Action id="inspect-parent" label={t("inspect.parent")} onPress={onParent} />
            <Action id="inspect-copy" label={t("inspect.copy")} onPress={onCopy} />
          </View>

          <SectionLabel>{t("inspect.font")}</SectionLabel>
          <Text testID="inspect-font" variant="headline">
            {font.rendered}
          </Text>
          <Text testID="inspect-font-kind" variant="subhead" tone="muted">
            {fontKind(font, t)}
          </Text>
          <Row label={t("inspect.size")} value={`${font.size} / ${font.lineHeight}`} />
          <Row label={t("inspect.weight")} value={font.style === "normal" ? font.weight : `${font.weight} ${font.style}`} />
          {font.letterSpacing !== "normal" ? <Row label={t("inspect.spacing")} value={font.letterSpacing} /> : null}
          <Row label={t("inspect.stack")} value={font.stack.join(", ")} />
          {font.source ? <Row label={t("inspect.file")} value={font.source} /> : null}

          <SectionLabel>{t("inspect.colour")}</SectionLabel>
          <View className="flex-row items-center gap-2">
            <Swatch color={element.swatches.color} />
            <Text testID="inspect-color" style={{ fontFamily: MONOSPACE }} variant="subhead">
              {element.color}
            </Text>
            <Text variant="subhead" tone="muted">
              {t("inspect.on")}
            </Text>
            <Swatch color={element.swatches.background} />
            <Text style={{ fontFamily: MONOSPACE }} variant="subhead">
              {element.background}
            </Text>
          </View>

          {element.rules.length ? <SectionLabel>{t("inspect.css")}</SectionLabel> : null}
          {element.rules.map((rule, index) => (
            <View key={`${rule.selector}-${index}`} className="mb-2 bg-default p-3" style={{ borderRadius: radius.tile }}>
              <View className="flex-row justify-between gap-2">
                <Text numberOfLines={1} variant="caption" weight="semibold" className="flex-1" style={{ fontFamily: MONOSPACE }}>
                  {rule.selector}
                </Text>
                {rule.source ? (
                  <Text numberOfLines={1} variant="caption" weight="regular" tone="muted" style={{ maxWidth: "40%" }}>
                    {rule.source}
                  </Text>
                ) : null}
              </View>
              {rule.decls.map(([property, value], line) => (
                <Text key={line} numberOfLines={2} variant="caption" weight="regular" style={{ fontFamily: MONOSPACE }}>
                  <Text variant="caption" weight="regular" tone="muted" style={{ fontFamily: MONOSPACE }}>
                    {property}:
                  </Text>{" "}
                  {value};
                </Text>
              ))}
            </View>
          ))}
        </>
      ) : null}
    </PanelSheet>
  );
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** Where the rendered font comes from, and why it isn't the first choice when it isn't. */
function fontKind(font: InspectedFont, t: Translate): string {
  const kind = font.web ? t("inspect.webFont") : GENERIC_FAMILIES.has(font.rendered.toLowerCase()) ? t("inspect.systemFont") : t("inspect.installedFont");
  const first = font.stack[0];

  return first && first !== font.rendered ? t("inspect.fontMissing", { kind, first }) : kind;
}

function Action({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="min-h-11 flex-1 items-center justify-center rounded-full bg-default px-3"
    >
      <Text variant="subhead">{label}</Text>
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="mt-1 flex-row gap-3">
      <Text variant="subhead" tone="muted" className="w-16">
        {label}
      </Text>
      <Text numberOfLines={2} variant="subhead" className="flex-1">
        {value}
      </Text>
    </View>
  );
}

// The colour's value is written beside it, so readers skip the swatch.
function Swatch({ color }: { color: string }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-4 w-4 rounded border border-black/15 dark:border-white/20"
      style={{ backgroundColor: color }}
    />
  );
}
