import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import * as Clipboard from "expo-clipboard";
import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { PillButton } from "@/chrome/PillButton";
import type { ImportedTab } from "@/browser/importTabs";
import { importedTabs } from "@/browser/importTabs";

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
    <PanelSheet visible={visible} onClose={onClose} title="Import tabs" testID="import-screen" height="80%">
      <Typography className="text-sm text-muted">
        Paste a list of tabs copied from Arc Search or another browser. Bay finds the links and ignores the rest.
      </Typography>
      <View className="mt-3 rounded-[20px] bg-default p-3">
        <BottomSheetTextInput
          testID="import-text"
          accessibilityLabel="Tabs to import"
          value={text}
          onChangeText={setText}
          placeholder="https://example.com&#10;https://another.com"
          placeholderTextColor={muted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={{ color: foreground, fontSize: 15, lineHeight: 21, minHeight: 150, padding: 0, textAlignVertical: "top" }}
        />
      </View>
      <View className="mt-2 flex-row items-center justify-between">
        <Typography testID="import-count" className="text-sm text-muted">
          {count ? `${count} ${count === 1 ? "link" : "links"} found` : "No links yet"}
        </Typography>
        <PillButton
          testID="import-paste"
          label="Paste"
          accessibilityLabel="Paste from the clipboard"
          compact
          onPress={() => {
            void paste();
          }}
        />
      </View>
      {pasteFailed ? (
        <Typography testID="import-paste-error" accessibilityRole="alert" className="mt-2 text-sm text-danger">
          Couldn't read the clipboard. Paste the list into the field instead.
        </Typography>
      ) : null}
      <View className="mt-4 flex-row items-center justify-end gap-2">
        <PillButton
          testID="import-archive"
          label="Archive"
          accessibilityLabel="Archive the links"
          disabled={!count}
          onPress={() => onImport(tabs, "archive")}
        />
        <PillButton
          testID="import-open"
          label="Open tabs"
          accessibilityLabel="Open the links as tabs"
          disabled={!count}
          onPress={() => onImport(tabs, "tabs")}
        />
      </View>
      <Typography className="mt-3 text-xs text-muted">Links already open in a tab are skipped. Archive keeps them until you open them.</Typography>
    </PanelSheet>
  );
}
