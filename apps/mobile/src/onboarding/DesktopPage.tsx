import * as Clipboard from "expo-clipboard";
import { useEffect, useState, type JSX } from "react";
import { Image, View } from "react-native";

import { press } from "@/chrome/haptics";
import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

import { useRun } from "./run";

/** Bay's site, where the desktop app is. */
export const BAY_SITE = "https://bay.krishkalaria.in";

const PICTURE = { width: 340, height: 202 };

/** Bay on a Mac, as its site shows it. */
export function DesktopPicture(): JSX.Element {
  const t = useT();

  return (
    <View
      style={{
        width: PICTURE.width,
        height: PICTURE.height,
        shadowColor: "#141C36",
        shadowOpacity: 0.18,
        shadowRadius: 13,
        shadowOffset: { width: 0, height: 18 },
      }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t("welcome.desktop.picture")}
    >
      <Image
        source={require("../../assets/welcome/bay-for-mac.jpg")}
        style={{ width: PICTURE.width, height: PICTURE.height, borderRadius: radius.control }}
        resizeMode="cover"
      />
    </View>
  );
}

/** Under the picture: one capsule, Bay for Mac, its address and Copy. */
export function DesktopLink(): JSX.Element {
  const { colors } = useRun();
  const t = useT();

  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: 14 }}>
      <Image
        source={require("../../assets/images/bay-mark.png")}
        style={{ width: 40, height: 40, borderRadius: radius.control }}
        accessibilityIgnoresInvertColors
      />
      <View style={{ flex: 1 }} accessible accessibilityLabel={t("welcome.desktop.siteLabel")}>
        <Text weight="semibold" color={colors.ink} numberOfLines={1}>
          {t("welcome.desktop.app")}
        </Text>
        <Text variant="subhead" color={colors.words} numberOfLines={1}>
          {BAY_SITE.replace("https://", "")}
        </Text>
      </View>
      <CopyButton text={BAY_SITE} />
    </View>
  );
}

/** Copy → Copied, with the clipboard turning into a check; back after two seconds. */
function CopyButton({ text }: { text: string }): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <PressFeedback
      testID="welcome-copy-link"
      accessibilityRole="button"
      accessibilityLabel={t(copied ? "welcome.copied" : "welcome.copy")}
      onPress={() => {
        void Clipboard.setStringAsync(text);
        press();
        setCopied(true);
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 36,
        paddingHorizontal: 14,
        borderRadius: 18,
        backgroundColor: "rgba(255,255,255,0.9)",
        shadowColor: "#000000",
        shadowOpacity: 0.08,
        shadowRadius: 2,
        shadowOffset: { width: 0, height: 1 },
      }}
    >
      <Icon name={copied ? "check" : "copy"} color="#1C1B19" size={iconSize.inline} />
      <Text variant="subhead" weight="semibold" color="#1C1B19">
        {t(copied ? "welcome.copied" : "welcome.copy")}
      </Text>
    </PressFeedback>
  );
}
