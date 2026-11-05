import { hostOf } from "@bay/core/src/input.ts";
import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";

import { Icon } from "@/chrome/Icon";
import { Surface } from "@/chrome/Surface";
import { describePageError } from "./pageErrors";

/** Covers a page that failed to load, in place of the engine's own error page. */
export function PageError({ url, message, onRetry }: { url: string; message: string; onRetry: () => void }): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const text = describePageError(message);
  return (
    <View testID="page-error" className="absolute inset-0 items-center justify-center bg-background px-10">
      <Icon name={text.kind} color={muted} size={44} />
      <Text accessibilityRole="header" style={{ color: foreground, fontSize: 20, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
        {text.title}
      </Text>
      {hostOf(url) ? <Text style={{ color: muted, fontSize: 15, marginTop: 4 }}>{hostOf(url)}</Text> : null}
      {text.detail !== message ? <Text style={{ color: muted, fontSize: 14, marginTop: 12, textAlign: "center" }}>{text.detail}</Text> : null}
      <Text testID="navigation-error" style={{ color: muted, fontSize: text.detail !== message ? 11 : 14, marginTop: 6, textAlign: "center" }}>
        {message}
      </Text>
      <Pressable testID="page-error-retry" accessibilityRole="button" accessibilityLabel="Try again" onPress={onRetry} className="mt-6 active:opacity-70">
        <Surface radius={22} style={{ paddingHorizontal: 22, paddingVertical: 12 }}>
          <Text style={{ color: foreground, fontSize: 15, fontWeight: "500" }}>Try again</Text>
        </Surface>
      </Pressable>
    </View>
  );
}
