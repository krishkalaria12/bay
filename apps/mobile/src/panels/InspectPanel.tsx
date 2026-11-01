import { Typography } from "heroui-native";
import type { JSX } from "react";
import { Platform, Pressable, View } from "react-native";

import type { InspectedElement, InspectedFont } from "@/pagescripts/inspect";

import { PanelSheet, SectionLabel } from "./PanelSheet";

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

export interface InspectPanelProps {
  element: InspectedElement | null;
  onClose: () => void;
  onParent: () => void;
  onCopy: () => void;
}

/** What the picked element is: its font first (the font identifier), then size, colours and the CSS that matches. */
export function InspectPanel({ element, onClose, onParent, onCopy }: InspectPanelProps): JSX.Element {
  const font = element?.font;
  return (
    <PanelSheet visible={element !== null} onClose={onClose} title="Inspect" testID="inspect-panel" height="62%">
      {element && font ? (
        <>
          <View className="flex-row items-baseline justify-between gap-3">
            <Typography testID="inspect-name" numberOfLines={1} className="flex-1 font-semibold" style={{ fontFamily: MONOSPACE }}>
              {element.name}
            </Typography>
            <Typography testID="inspect-size" className="text-sm text-muted">
              {Math.round(element.width)} × {Math.round(element.height)}
            </Typography>
          </View>
          <View className="mt-3 flex-row gap-2">
            <Action id="inspect-parent" label="Parent" onPress={onParent} />
            <Action id="inspect-copy" label="Copy for agent" onPress={onCopy} />
          </View>

          <SectionLabel>Font</SectionLabel>
          <Typography testID="inspect-font" className="text-lg font-semibold">
            {font.rendered}
          </Typography>
          <Typography testID="inspect-font-kind" className="text-sm text-muted">
            {fontKind(font)}
          </Typography>
          <Row label="Size" value={`${font.size} / ${font.lineHeight}`} />
          <Row label="Weight" value={font.style === "normal" ? font.weight : `${font.weight} ${font.style}`} />
          {font.letterSpacing !== "normal" ? <Row label="Spacing" value={font.letterSpacing} /> : null}
          <Row label="Stack" value={font.stack.join(", ")} />
          {font.source ? <Row label="File" value={font.source} /> : null}

          <SectionLabel>Colour</SectionLabel>
          <View className="flex-row items-center gap-2">
            <Swatch color={element.swatches.color} />
            <Typography testID="inspect-color" style={{ fontFamily: MONOSPACE }} className="text-sm">
              {element.color}
            </Typography>
            <Typography className="text-sm text-muted">on</Typography>
            <Swatch color={element.swatches.background} />
            <Typography style={{ fontFamily: MONOSPACE }} className="text-sm">
              {element.background}
            </Typography>
          </View>

          {element.rules.length ? <SectionLabel>Matched CSS</SectionLabel> : null}
          {element.rules.map((rule, index) => (
            <View key={`${rule.selector}-${index}`} className="mb-2 rounded-xl bg-default p-3">
              <View className="flex-row justify-between gap-2">
                <Typography numberOfLines={1} className="flex-1 text-xs font-semibold" style={{ fontFamily: MONOSPACE }}>
                  {rule.selector}
                </Typography>
                {rule.source ? (
                  <Typography numberOfLines={1} className="text-xs text-muted" style={{ maxWidth: "40%" }}>
                    {rule.source}
                  </Typography>
                ) : null}
              </View>
              {rule.decls.map(([property, value], line) => (
                <Typography key={line} numberOfLines={2} className="text-xs" style={{ fontFamily: MONOSPACE }}>
                  <Typography className="text-xs text-muted" style={{ fontFamily: MONOSPACE }}>
                    {property}:
                  </Typography>{" "}
                  {value};
                </Typography>
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
function fontKind(font: InspectedFont): string {
  const kind = font.web ? "Web font" : GENERIC_FAMILIES.has(font.rendered.toLowerCase()) ? "The system's default font" : "Installed font";
  const first = font.stack[0];
  return first && first !== font.rendered ? `${kind}; ${first} isn't available` : kind;
}

function Action({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="min-h-11 flex-1 items-center justify-center rounded-2xl bg-default px-3"
    >
      <Typography className="text-sm">{label}</Typography>
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="mt-1 flex-row gap-3">
      <Typography className="w-16 text-sm text-muted">{label}</Typography>
      <Typography numberOfLines={2} className="flex-1 text-sm">
        {value}
      </Typography>
    </View>
  );
}

function Swatch({ color }: { color: string }) {
  return <View className="h-4 w-4 rounded border border-black/15 dark:border-white/20" style={{ backgroundColor: color }} />;
}
