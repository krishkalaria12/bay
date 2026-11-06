import { hostOf } from "@bay/core/src/input.ts";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Typography, useThemeColor } from "heroui-native";
import { useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { PillButton } from "@/chrome/PillButton";

import { PanelSheet } from "./PanelSheet";
import type { PageRequest } from "@bay/engine";

export interface PageRequestPanelProps {
  /** The dialog the page is waiting on, or null when no page is asking. */
  request: PageRequest | null;
  /** Answers the dialog: accepted is OK vs Cancel, value is the prompt's entered text. Closing the sheet cancels. */
  onAnswer: (accepted: boolean, value?: string) => void;
}

/**
 * A page's `alert`/`confirm`/`prompt` (I3), as one shared sheet on both apps instead of WebKit's or WebView's own
 * dialogs. The engine holds the page paused until this answers, so dismissing the sheet cancels the dialog, as a
 * dismissed browser dialog would.
 */
export function PageRequestPanel({ request, onAnswer }: PageRequestPanelProps): JSX.Element {
  const host = request ? hostOf(request.url) : "";
  // Answering closes the sheet, and the sheet closing reports back as a dismissal too: answer each dialog once, so
  // the dismissal can't cancel the next dialog in the queue.
  const answered = useRef<string | null>(null);

  function answer(accepted: boolean, value?: string): void {
    if (!request || answered.current === request.id) return;
    answered.current = request.id;
    onAnswer(accepted, value);
  }

  return (
    <PanelSheet visible={request !== null} onClose={() => answer(false)} title={host || "This page"} testID="page-request" height="52%">
      {request ? <RequestBody key={request.id} request={request} onAnswer={answer} /> : null}
    </PanelSheet>
  );
}

function RequestBody({ request, onAnswer }: { request: PageRequest; onAnswer: (accepted: boolean, value?: string) => void }): JSX.Element {
  const foreground = useThemeColor("foreground");
  const [value, setValue] = useState(request.defaultValue ?? "");

  return (
    <>
      {request.message ? (
        <Typography testID="page-request-message" style={{ fontSize: 16, lineHeight: 22 }}>
          {request.message}
        </Typography>
      ) : null}
      {request.kind === "prompt" ? (
        <View className="mt-3 flex-row items-center rounded-full bg-default px-4">
          <BottomSheetTextInput
            testID="page-request-input"
            accessibilityLabel="Your answer"
            value={value}
            onChangeText={setValue}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => onAnswer(true, value)}
            style={{ flex: 1, color: foreground, fontSize: 16, paddingVertical: 10 }}
          />
        </View>
      ) : null}
      <View className="mt-4 flex-row items-center justify-end gap-2">
        {request.kind !== "alert" ? (
          <PillButton testID="page-request-cancel" label="Cancel" accessibilityLabel="Cancel" onPress={() => onAnswer(false)} />
        ) : null}
        <PillButton testID="page-request-ok" label="OK" accessibilityLabel="OK" onPress={() => onAnswer(true, request.kind === "prompt" ? value : undefined)} />
      </View>
      {request.url ? (
        <Typography testID="page-request-url" className="mt-3 text-sm text-muted" numberOfLines={1}>
          {request.url}
        </Typography>
      ) : null}
    </>
  );
}
