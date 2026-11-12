import { hostOf } from "@bay/core/src/input.ts";
import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { View } from "react-native";

import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { describePageError, pageErrorId } from "./pageErrors";

/** Covers a page that failed to load, in place of the engine's own error page. */
export function PageError({ url, message, onRetry }: { url: string; message: string; onRetry: () => void }): JSX.Element {
  const muted = useThemeColor("muted");
  const t = useT();

  // The English words decide what is shown; the catalogue says them in the reader's language.
  const english = describePageError(message);
  const id = pageErrorId(message);

  const text = {
    kind: english.kind,
    title: id === "unknown" ? t("pageError.unknown.title") : t(`pageError.${id}.title`),
    detail: id === "unknown" ? english.detail : t(`pageError.${id}.detail`),
  };

  const known = id !== "unknown";

  return (
    <View testID="page-error" className="absolute inset-0 items-center justify-center bg-background px-10">
      <Icon name={text.kind} color={muted} size={44} />
      <Text accessibilityRole="header" variant="title" weight="semibold" style={{ marginTop: 16, textAlign: "center" }}>
        {text.title}
      </Text>
      {hostOf(url) ? (
        <Text variant="callout" tone="muted" style={{ marginTop: 4 }}>
          {hostOf(url)}
        </Text>
      ) : null}
      {known ? (
        <Text variant="subhead" tone="muted" style={{ marginTop: 12, textAlign: "center" }}>
          {text.detail}
        </Text>
      ) : null}
      <Text testID="navigation-error" variant={known ? "caption" : "subhead"} weight="regular" tone="muted" style={{ marginTop: 6, textAlign: "center" }}>
        {message}
      </Text>
      <PressFeedback testID="page-error-retry" accessibilityRole="button" accessibilityLabel={t("pageError.tryAgain")} onPress={onRetry} className="mt-6">
        <Surface radius={radius.card} style={{ paddingHorizontal: space.xl, paddingVertical: space.md }}>
          <Text variant="callout" weight="medium">
            {t("pageError.tryAgain")}
          </Text>
        </Surface>
      </PressFeedback>
    </View>
  );
}
