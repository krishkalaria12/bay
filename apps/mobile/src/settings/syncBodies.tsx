// Sync's two pages that draw their own body: the code this phone shows for a computer to let it in, and the recovery
// phrase typed by hand. Each goes back to Settings › Sync once the phone syncs.
import * as Effect from "effect/Effect";
import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { TextInput, View } from "react-native";

import { Text } from "@/chrome/Text";
import { inputFont, radius, space } from "@/chrome/tokens";
import { useCommand } from "@/effect/react";
import { useT, type MessageKey } from "@/i18n";
import { formatCode } from "@bay/sync/src/relay/pairing.ts";
import type { PhraseProblem } from "@bay/sync/src/relay/phrase.ts";
import { PhoneSync } from "@/sync/service";
import { useSyncStore } from "@/sync/state";

import { Section } from "./SettingsRows";

/** Back to Settings › Sync once the phone syncs. */
function useBackWhenJoined(back: () => void) {
  const status = useSyncStore((state) => state.status);

  useEffect(() => {
    if (status !== "off") back();
  }, [status, back]);
}

/** The code, waited under while this page is open; a new one when it runs out. */
export function SyncJoin({ back }: { back: () => void }): JSX.Element {
  const t = useT();
  const pairing = useSyncStore((state) => state.pairing);
  const { run } = useCommand<void, never>();
  const [attempt, setAttempt] = useState(0);

  useBackWhenJoined(back);

  useEffect(() => {
    run(PhoneSync.use((sync) => sync.pair));

    return () => run(PhoneSync.use((sync) => sync.cancelPairing));
  }, [run, attempt]);

  let words: MessageKey = "sync.code.starting";

  if (pairing?.state === "expired") words = "sync.code.expired";

  if (pairing?.state === "failed") words = "sync.code.failed";

  return (
    <View style={{ gap: space.section }}>
      <View
        className="items-center bg-surface"
        style={{ borderRadius: radius.card, paddingVertical: space.xl, paddingHorizontal: space.gutter, gap: space.md }}
      >
        <Text variant="subhead" tone="muted" className="text-center">
          {t("sync.code.title")}
        </Text>
        {pairing?.state === "waiting" ? (
          <>
            <Text
              testID="sync-code"
              accessibilityLabel={pairing.code.split("").join(" ")}
              variant="display"
              weight="bold"
              selectable
              style={{ letterSpacing: 2 }}
            >
              {formatCode(pairing.code)}
            </Text>
            <Text testID="sync-code-digits" variant="footnote" tone="muted" className="text-center">
              {t("sync.code.digits", { digits: pairing.digits })}
            </Text>
          </>
        ) : (
          <Text testID="sync-code-state" variant="body" tone={pairing?.state === "failed" ? "danger" : "muted"} className="text-center">
            {t(words)}
          </Text>
        )}
      </View>
      {pairing?.state === "expired" || pairing?.state === "failed" ? (
        <Section
          section={{
            id: "again",
            rows: [{ id: "again", testID: "sync-code-again", label: t("sync.code.again"), kind: { type: "action", run: () => setAttempt((n) => n + 1) } }],
          }}
        />
      ) : null}
      <Text variant="footnote" tone="muted" style={{ paddingHorizontal: space.sm }}>
        {t("sync.join.note")}
      </Text>
    </View>
  );
}

const PROBLEMS: Record<PhraseProblem["kind"], MessageKey> = {
  wordCount: "sync.phrase.wordCount",
  unknownWord: "sync.phrase.unknownWord",
  checksum: "sync.phrase.checksum",
};

/** The 24 words, typed; Join says what's wrong with them, or joins. */
export function SyncPhrase({ back }: { back: () => void }): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<PhraseProblem | null>(null);
  const { run, running } = useCommand<void, never>();

  useBackWhenJoined(back);

  const join = () => run(PhoneSync.use((sync) => sync.joinWithPhrase(text)).pipe(Effect.flatMap((result) => Effect.sync(() => setProblem(result)))));

  return (
    <View style={{ gap: space.section }}>
      <View className="bg-surface px-4" style={{ borderRadius: radius.card }}>
        <TextInput
          testID="sync-phrase-field"
          accessibilityLabel={t("settings.page.syncPhrase")}
          value={text}
          onChangeText={(next) => {
            setText(next);
            setProblem(null);
          }}
          placeholder={t("sync.phrase.placeholder")}
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          textAlignVertical="top"
          style={[inputFont("body"), { color: foreground, minHeight: 120, paddingVertical: space.md }]}
        />
      </View>
      {problem ? (
        <Text testID="sync-phrase-problem" accessibilityRole="alert" variant="footnote" tone="danger" style={{ paddingHorizontal: space.sm }}>
          {t(PROBLEMS[problem.kind], problem.kind === "wordCount" ? { count: problem.count } : problem.kind === "unknownWord" ? { word: problem.word } : {})}
        </Text>
      ) : null}
      <Section
        section={{
          id: "join",
          rows: [
            { id: "join", testID: "sync-phrase-join", label: t("sync.phrase.join"), disabled: running || !text.trim(), kind: { type: "action", run: join } },
          ],
          footer: t("sync.phrase.note"),
        }}
      />
    </View>
  );
}
