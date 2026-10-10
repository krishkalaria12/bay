import { Symbol } from "@bay/shell";
import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { Popover } from "../layout/controls";
import { useHover } from "../primitives";
import { answerDeveloperOffer, useDeveloperOffer } from "./devMode";
import { DEVELOPER_OFFER_WIDTH, DEVELOPER_YELLOW } from "./constants";

/**
 * "Turn on Developer Mode for localhost:3000?", over a local server's page the first time it's shown. It takes the
 * keyboard while it's up, so Return turns it on and Esc says not now, as its keys show.
 */
export function DeveloperOffer({ tabId, left, top, paneWidth }: { tabId: string; left: number; top: number; paneWidth: number }) {
  const site = useDeveloperOffer(tabId);
  if (!site) return null;
  return <Offer key={site} tabId={tabId} site={site} left={left} top={top} width={Math.min(DEVELOPER_OFFER_WIDTH, paneWidth - 2 * left)} />;
}

function Offer({ tabId, site, left, top, width }: { tabId: string; site: string; left: number; top: number; width: number }) {
  const theme = useTheme();
  const keys = useRef<View>(null);
  useEffect(() => {
    const t = setTimeout(() => (keys.current as unknown as { focus?: () => void } | null)?.focus?.(), 50);
    return () => clearTimeout(t);
  }, []);
  const answer = (on: boolean) => answerDeveloperOffer(tabId, on);
  return (
    <Popover width={width} top={top} left={left} modal={false}>
      <View
        ref={keys}
        focusable
        enableFocusRing={false}
        keyDownEvents={[{ key: "Escape" }, { key: "Enter" }]}
        onKeyDown={(e) => answer(e.nativeEvent.key === "Enter")}
        style={{ padding: 14, gap: 12 }}
      >
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 9,
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: DEVELOPER_YELLOW,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
            }}
          >
            <Symbol name="chevron.left.forwardslash.chevron.right" size={14} weight="medium" color={theme.textPrimary} style={{ width: 22, height: 22 }} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.textPrimary }}>Turn on Developer Mode for {site}?</Text>
            <Text style={{ fontSize: 12, lineHeight: 16, color: theme.textSecondary }}>
              Its whole address over the page, with an inspector, screenshots and DevTools a click away.
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <KeyButton title="Not Now" keyLabel="esc" onPress={() => answer(false)} />
          <KeyButton title="Turn On" keyLabel="⏎" primary onPress={() => answer(true)} />
        </View>
      </View>
    </Popover>
  );
}

function KeyButton({ title, keyLabel, primary, onPress }: { title: string; keyLabel: string; primary?: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const light = primary === theme.dark;
  let fill: string;
  if (primary && theme.dark) fill = hovered ? "#FFFFFF" : "#E6E6E8";
  else if (primary) fill = hovered ? "#2C2C2E" : "#1C1C1E";
  else if (theme.dark) fill = `rgba(255,255,255,${hovered ? 0.14 : 0.09})`;
  else fill = `rgba(0,0,0,${hovered ? 0.09 : 0.06})`;
  const text = primary ? (theme.dark ? "#1C1C1E" : "#FFFFFF") : theme.textPrimary;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View
          style={{ height: 30, borderRadius: 8, paddingLeft: 11, paddingRight: 4, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: fill }}
        >
          <Text style={{ fontSize: 13, fontWeight: "500", color: text }}>{title}</Text>
          <View
            style={{
              minWidth: 24,
              height: 22,
              borderRadius: 5,
              paddingHorizontal: 5,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: light ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.12)",
            }}
          >
            <Text style={{ fontSize: 11.5, fontWeight: "500", color: text, opacity: 0.75 }}>{keyLabel}</Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}
