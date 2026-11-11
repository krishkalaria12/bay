import { hostOf } from "@bay/core/src/input.ts";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useThemeColor } from "heroui-native";
import { useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { PillButton } from "@/chrome/PillButton";
import { Text } from "@/chrome/Text";
import { inputFont } from "@/chrome/tokens";
import { useT, type MessageKey } from "@/i18n";

import { ActionRow, PanelSheet } from "./PanelSheet";
import type { PageRequest } from "@bay/engine";

export interface PageRequestPanelProps {
  /** The dialog the page is waiting on, or null when no page is asking. */
  request: PageRequest | null;
  /**
   * Answers the dialog: accepted is OK vs Cancel, value is the prompt's entered text, username and password the sign-in;
   * save (auth only) asks Bay to keep the sign-in for next time.
   */
  onAnswer: (accepted: boolean, value?: string, username?: string, password?: string, save?: boolean) => void;
}

/** What a page asking for a device says, in Bay's own words on both apps. */
const permissionMessages: Record<NonNullable<PageRequest["permission"]>, MessageKey> = {
  camera: "pageRequest.permission.camera",
  microphone: "pageRequest.permission.microphone",
  location: "pageRequest.permission.location",
  "camera-microphone": "pageRequest.permission.cameraMicrophone",
};

/**
 * A page's `alert`/`confirm`/`prompt` (I3), the server's HTTP sign-in (B3), a link to another app (B5) or a device
 * permission (B7), as one shared sheet on both apps instead of WebKit's or WebView's own dialogs. The engine holds the
 * page paused until this answers, so dismissing the sheet cancels the dialog, as a dismissed browser dialog would.
 */
export function PageRequestPanel({ request, onAnswer }: PageRequestPanelProps): JSX.Element {
  const t = useT();
  const host = request ? hostOf(request.url) : "";
  // Answering closes the sheet, and the sheet closing reports back as a dismissal too: answer each dialog once, so
  // the dismissal can't cancel the next dialog in the queue.
  const answered = useRef<string | null>(null);

  function answer(accepted: boolean, value?: string, username?: string, password?: string): void {
    if (!request || answered.current === request.id) return;
    answered.current = request.id;
    onAnswer(accepted, value, username, password);
  }

  return (
    <PanelSheet
      visible={request !== null}
      onClose={() => answer(false)}
      title={host || t("pageRequest.thisPage")}
      testID="page-request"
      height={request?.kind === "auth" ? "72%" : "52%"}
    >
      {request ? <RequestBody key={request.id} request={request} onAnswer={answer} /> : null}
    </PanelSheet>
  );
}

function RequestBody({
  request,
  onAnswer,
}: {
  request: PageRequest;
  onAnswer: (accepted: boolean, value?: string, username?: string, password?: string, save?: boolean) => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  const t = useT();
  const [value, setValue] = useState(request.defaultValue ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Saved passwords (B20): signing in can file the login for next time.
  const [save, setSave] = useState(false);

  function submit(): void {
    onAnswer(
      true,
      request.kind === "prompt" ? value : undefined,
      request.kind === "auth" ? username : undefined,
      request.kind === "auth" ? password : undefined,
      request.kind === "auth" ? save : undefined,
    );
  }

  return (
    <>
      {request.kind === "auth" ? (
        <Text testID="page-request-realm" variant="subhead" tone="muted">
          {request.realm ? t("pageRequest.auth.realm", { realm: request.realm }) : t("pageRequest.auth.site")}
        </Text>
      ) : request.kind === "permission" ? (
        <Text testID="page-request-permission-message" variant="body">
          {t(permissionMessages[request.permission ?? "camera"])}
        </Text>
      ) : request.kind === "external" ? (
        <>
          <Text testID="page-request-external-message">{t("pageRequest.external")}</Text>
          <Text testID="page-request-external" variant="subhead" tone="muted" className="mt-2" numberOfLines={2}>
            {request.externalUrl ?? ""}
          </Text>
        </>
      ) : request.message ? (
        <Text testID="page-request-message" variant="body">
          {request.message}
        </Text>
      ) : null}
      {request.kind === "prompt" ? (
        <View className="mt-3 flex-row items-center rounded-full bg-default px-4">
          <BottomSheetTextInput
            testID="page-request-input"
            accessibilityLabel={t("pageRequest.answer")}
            value={value}
            onChangeText={setValue}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={submit}
            style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 10 }]}
          />
        </View>
      ) : null}
      {request.kind === "auth" ? (
        <>
          <View className="mt-3 flex-row items-center rounded-full bg-default px-4">
            <BottomSheetTextInput
              testID="page-request-username"
              accessibilityLabel={t("pageRequest.username")}
              value={username}
              onChangeText={setUsername}
              placeholder={t("pageRequest.username")}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 10 }]}
            />
          </View>
          <View className="mt-2 flex-row items-center rounded-full bg-default px-4">
            <BottomSheetTextInput
              testID="page-request-password"
              accessibilityLabel={t("pageRequest.password")}
              value={password}
              onChangeText={setPassword}
              placeholder={t("pageRequest.password")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={submit}
              style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 10 }]}
            />
          </View>
          <View className="mt-2">
            <ActionRow
              testID="page-request-save-password"
              label={t("pageRequest.savePassword", { host: hostOf(request.url) || t("pageRequest.thisSite") })}
              toggle={save}
              onPress={() => setSave((on) => !on)}
            />
          </View>
        </>
      ) : null}
      <View className="mt-4 flex-row items-center justify-end gap-2">
        {request.kind !== "alert" ? (
          <PillButton
            testID="page-request-cancel"
            label={request.kind === "permission" ? t("pageRequest.dontAllow") : t("pageRequest.cancel")}
            accessibilityLabel={request.kind === "permission" ? t("pageRequest.dontAllow") : t("pageRequest.cancel")}
            onPress={() => onAnswer(false)}
          />
        ) : null}
        <PillButton
          testID="page-request-ok"
          label={
            request.kind === "auth"
              ? t("pageRequest.signIn")
              : request.kind === "external"
                ? t("pageRequest.open")
                : request.kind === "permission"
                  ? t("pageRequest.allow")
                  : t("pageRequest.ok")
          }
          accessibilityLabel={
            request.kind === "auth"
              ? t("pageRequest.signIn")
              : request.kind === "external"
                ? t("pageRequest.openElsewhere")
                : request.kind === "permission"
                  ? t("pageRequest.allow")
                  : t("pageRequest.ok")
          }
          onPress={submit}
        />
      </View>
      {request.url ? (
        <Text testID="page-request-url" variant="subhead" tone="muted" className="mt-3" numberOfLines={1}>
          {request.url}
        </Text>
      ) : null}
    </>
  );
}
