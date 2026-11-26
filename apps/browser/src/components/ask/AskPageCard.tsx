import { TextInput, View } from "@bay/platform";
import { Surface, Symbol } from "@bay/desktop";
import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { onEscapeKey } from "../../lib/escapeKey";
import { webviews } from "../../lib/webviews";
import { IconButton } from "../ui/primitives";
import { askAboutPage, closeAskPage, useAskPage } from "./askPage";

/** Ask on Page's card, at the page's top right like Find: a question, and the Mac's on-device answer. */
export function AskPageCard({ tabId }: { tabId: string }) {
  const ask = useAskPage((s) => s[tabId]);

  if (!ask?.open) return null;

  return <AskPanel key={tabId} tabId={tabId} />;
}

function AskPanel({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const ask = useAskPage((s) => s[tabId]);
  const [question, setQuestion] = useState(ask?.question ?? "");

  const close = () => {
    closeAskPage(tabId);
    void webviews.get(tabId)?.focus();
  };

  let body: string | null = null;

  if (ask?.asking) body = "Reading the page…";
  else if (ask?.failed) body = "Apple Intelligence couldn't answer that about this page.";
  else if (ask?.answer) body = ask.answer;

  return (
    <View style={{ position: "absolute", top: 10, right: 12 }}>
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={12}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={16}
        shadowOffset={[0, 6]}
        style={{ width: 380 }}
      >
        <View style={{ height: 40, flexDirection: "row", alignItems: "center", paddingLeft: 11, paddingRight: 4, gap: 2 }}>
          <Symbol name="sparkles" size={13} color={theme.textSecondary} style={{ width: 16, height: 16, marginRight: 5 }} />
          <TextInput
            autoFocus
            value={question}
            onChangeText={setQuestion}
            placeholder="Ask about this page"
            placeholderTextColor={theme.placeholder}
            selectionColor={theme.selection}
            enableFocusRing={false}
            onSubmitEditing={() => void askAboutPage(tabId, question)}
            keyDownEvents={[{ key: "Escape" }]}
            onKeyPress={onEscapeKey(close)}
            style={{ flex: 1, fontSize: 14, color: theme.textPrimary, paddingVertical: 0 }}
          />
          <IconButton icon="xmark" size={11} box={26} radius={6} onPress={close} tooltip="Done (Esc)" />
        </View>
        {body !== null && (
          <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ paddingHorizontal: 13, paddingBottom: 12 }}>
            <Text selectable style={{ fontSize: 13, lineHeight: 19, color: ask?.answer ? theme.textPrimary : theme.textSecondary }}>
              {body}
            </Text>
          </ScrollView>
        )}
        {body === null && (
          <Text style={{ paddingHorizontal: 13, paddingBottom: 11, fontSize: 11.5, color: theme.textTertiary }}>
            Answered on this Mac by Apple Intelligence. The page doesn't leave it.
          </Text>
        )}
      </Surface>
    </View>
  );
}
