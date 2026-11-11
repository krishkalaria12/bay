import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import * as Clipboard from "expo-clipboard";
import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { PillButton } from "@/chrome/PillButton";
import { Text } from "@/chrome/Text";
import { fontFor } from "@/chrome/tokens";
import type { ImportedTab } from "@/browser/importTabs";
import { importedTabs } from "@/browser/importTabs";
import { useT } from "@/i18n";

import { PanelSheet } from "./PanelSheet";

export interface ImportPanelProps {
  visible: boolean;
  onClose: () => void;
  /** Opens the links as background tabs, or puts them in the archive. */
  onImport: (tabs: readonly ImportedTab[], target: "tabs" | "archive") => void;
}

/**
 * Imports tabs exported from another browser (Arc Search shares its open tabs as text). The text is read on the
 * device only; links are found and deduplicated here before they become tabs or archive entries.
 */
export function ImportPanel({ visible, onClose, onImport }: ImportPanelProps): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const t = useT();
  const [text, setText] = useState("");
  const [pasteFailed, setPasteFailed] = useState(false);

  // Each opening starts clean: pasted text is only meaningful for the import it was pasted for.
  useEffect(() => {
    if (!visible) return;
    setText("");
    setPasteFailed(false);
  }, [visible]);

  const tabs = importedTabs(text);
  const count = tabs.length;

  async function paste(): Promise<void> {
    setPasteFailed(false);

    try {
      setText(await Clipboard.getStringAsync());
    } catch {
      setPasteFailed(true);
    }
  }

  return (
    <PanelSheet visible={visible} onClose={onClose} title={t("import.title")} testID="import-screen" height="80%">
      <Text variant="subhead" tone="muted">
        {t("import.help")}
      </Text>
      <View className="mt-3 rounded-[20px] bg-default p-3">
        <BottomSheetTextInput
          testID="import-text"
          accessibilityLabel={t("import.field")}
          value={text}
          onChangeText={setText}
          placeholder="https://example.com&#10;https://another.com"
          placeholderTextColor={muted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={[fontFor("callout"), { color: foreground, minHeight: 150, padding: 0, textAlignVertical: "top" }]}
        />
      </View>
      <View className="mt-2 flex-row items-center justify-between">
        <Text testID="import-count" accessibilityLiveRegion="polite" variant="subhead" tone="muted">
          {count ? (count === 1 ? t("import.oneLink") : t("import.linksFound", { count })) : t("import.none")}
        </Text>
        <PillButton
          testID="import-paste"
          label={t("import.paste")}
          accessibilityLabel={t("import.pasteLabel")}
          compact
          onPress={() => {
            void paste();
          }}
        />
      </View>
      {pasteFailed ? (
        <Text testID="import-paste-error" accessibilityRole="alert" accessibilityLiveRegion="assertive" variant="subhead" tone="danger" className="mt-2">
          {t("import.pasteFailed")}
        </Text>
      ) : null}
      <View className="mt-4 flex-row items-center justify-end gap-2">
        <PillButton
          testID="import-archive"
          label={t("import.archive")}
          accessibilityLabel={t("import.archiveLabel")}
          disabled={!count}
          onPress={() => onImport(tabs, "archive")}
        />
        <PillButton
          testID="import-open"
          label={t("import.open")}
          accessibilityLabel={t("import.openLabel")}
          disabled={!count}
          onPress={() => onImport(tabs, "tabs")}
        />
      </View>
      <Text variant="caption" weight="regular" tone="muted" className="mt-3">
        {t("import.note")}
      </Text>
    </PanelSheet>
  );
}
