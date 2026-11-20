import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import * as Clipboard from "expo-clipboard";
import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Image, Platform, View } from "react-native";

import { PillButton } from "@/chrome/PillButton";
import { Text } from "@/chrome/Text";
import { fontFor, iconSize, radius, space } from "@/chrome/tokens";
import type { ImportedTab } from "@/browser/importTabs";
import { importedTabs } from "@/browser/importTabs";
import { useCommand } from "@/effect/react";
import { useT, type MessageKey } from "@/i18n";
import type { PhoneBrowser } from "@/import/browsers";
import { TAKEOUT_URL } from "@/import/browsers";
import { linkCount } from "@/import/exports";
import { chooseExport, NothingToImport, phoneBrowsers, type ChosenExport } from "@/import/importer";
import type { ImportChoice, ImportCounts } from "@/store/browser";
import { HISTORY_LIMIT } from "@/store/model";

import { ActionRow, Group, PanelSheet } from "./PanelSheet";

export interface ImportPanelProps {
  visible: boolean;
  onClose: () => void;
  /** Opens pasted links as background tabs, or puts them in the archive. */
  onImportTabs: (tabs: readonly ImportedTab[], target: "tabs" | "archive") => void;
  /** Adds the chosen parts of an export; the folder its bookmarks go in is named for the browser. */
  onImportExport: (chosen: ChosenExport, choice: ImportChoice, folderName: string) => ImportCounts;
  /** Opens a page in a new tab (Google Takeout). */
  onOpenPage: (url: string) => void;
  onShowBookmarks: () => void;
}

type Step =
  | { kind: "sources" }
  | { kind: "guide"; browser: PhoneBrowser }
  | { kind: "paste" }
  | { kind: "review"; browser: PhoneBrowser; chosen: ChosenExport; choice: ImportChoice }
  | { kind: "done"; counts: ImportCounts };

/** "Another browser": any that can save its bookmarks as a file. */
const ANOTHER: PhoneBrowser = { id: "other", name: "", method: "bookmarksFile", icon: null };

/** What each way in says under its name in the list. */
const METHOD_DETAIL: Record<PhoneBrowser["method"], MessageKey> = {
  safari: "import.method.safari",
  takeout: "import.method.takeout",
  bookmarksFile: "import.method.file",
  paste: "import.method.paste",
};

/**
 * Bringing bookmarks, history and favorites from another browser. A phone's browsers keep their data to themselves,
 * so the sheet lists the ones on this phone and walks through how each hands its data over: Safari's export, Google
 * Takeout for Chrome, a bookmarks file for the rest, or a pasted list of tabs. The chosen file is read on the device;
 * what it held is reviewed before anything is added.
 */
export function ImportPanel(props: ImportPanelProps): JSX.Element {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: "sources" });
  const [browsers, setBrowsers] = useState<PhoneBrowser[]>([]);
  const looking = useCommand<PhoneBrowser[]>();
  const reading = useCommand<ChosenExport | NothingToImport | null>();
  const [readError, setReadError] = useState<string | null>(null);

  // Each opening starts at the list, which looks at the phone again: a browser may have been installed meanwhile.
  useEffect(() => {
    if (!props.visible) return;
    setStep({ kind: "sources" });
    setReadError(null);
    looking.run(phoneBrowsers(Platform.OS === "android" ? "android" : "ios"));
    // The command is the component's own and stays the same; only an opening asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  useEffect(() => {
    if (looking.result?._tag === "Done") setBrowsers(looking.result.value);
  }, [looking.result]);

  // A file that was read moves on to the review; one that wasn't says why, on the same step.
  useEffect(() => {
    const result = reading.result;

    if (!result || step.kind !== "guide") return;

    if (result._tag === "Done") {
      const read = result.value;

      if (read instanceof NothingToImport) {
        setReadError(t(read.tooLarge ? "import.error.tooLarge" : "import.error.nothing", { name: read.name }));
      } else if (read) {
        const { contents } = read;
        setStep({
          kind: "review",
          browser: step.browser,
          chosen: read,
          choice: { bookmarks: linkCount(contents.bookmarks) > 0, favorites: contents.favorites.length > 0, history: contents.history.length > 0 },
        });
      }

      return;
    }

    if (result._tag === "Failed") setReadError(t("import.error.unreadable"));
    // Only a new result changes the step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading.result]);

  const nameOf = (browser: PhoneBrowser) => browser.name || t("import.another");

  const choose = (browser: PhoneBrowser) => {
    setReadError(null);
    setStep(browser.method === "paste" ? { kind: "paste" } : { kind: "guide", browser });
  };

  const back = () => {
    setReadError(null);
    setStep({ kind: "sources" });
  };

  if (step.kind === "paste") {
    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} onBack={back} title={t("import.paste.title")} testID="import-screen" height="80%">
        <PasteTabs onImport={props.onImportTabs} />
      </PanelSheet>
    );
  }

  if (step.kind === "guide") {
    const busy = reading.running;

    return (
      <PanelSheet
        visible={props.visible}
        onClose={props.onClose}
        onBack={busy ? undefined : back}
        title={nameOf(step.browser)}
        testID="import-screen"
        height="80%"
      >
        <Guide method={step.browser.method} name={nameOf(step.browser)} named={Boolean(step.browser.name)} />
        {readError ? (
          <Text testID="import-error" accessibilityRole="alert" accessibilityLiveRegion="assertive" variant="subhead" tone="danger" className="mt-3">
            {readError}
          </Text>
        ) : null}
        <View className="mt-4 flex-row flex-wrap items-center justify-end gap-2">
          {step.browser.method === "takeout" ? (
            <PillButton
              testID="import-takeout"
              label={t("import.takeout.open")}
              accessibilityLabel={t("import.takeout.openLabel")}
              disabled={busy}
              onPress={() => {
                props.onClose();
                props.onOpenPage(TAKEOUT_URL);
              }}
            />
          ) : null}
          <PillButton
            testID="import-choose"
            label={busy ? t("import.reading") : t("import.choose")}
            accessibilityLabel={t("import.chooseLabel")}
            disabled={busy}
            onPress={() => {
              setReadError(null);
              reading.run(chooseExport);
            }}
          />
        </View>
      </PanelSheet>
    );
  }

  if (step.kind === "review") {
    const { contents, notes, name } = step.chosen;
    // Bookmarks from a browser the sheet couldn't name go in a folder that says only where they came from.
    const folderName = step.browser.name || t("import.importedFolder");
    const bookmarks = linkCount(contents.bookmarks);
    const history = contents.history.length;
    const favorites = contents.favorites.length;
    const { choice } = step;
    const toggle = (key: keyof ImportChoice) => setStep({ ...step, choice: { ...choice, [key]: !choice[key] } });

    const left =
      notes.passwords && notes.cards ? t("import.left.both") : notes.passwords ? t("import.left.passwords") : notes.cards ? t("import.left.cards") : "";

    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} onBack={back} title={t("import.review.title")} testID="import-screen" height="80%">
        <Text testID="import-review-file" variant="subhead" tone="muted" numberOfLines={2}>
          {t("import.review.from", { name })}
        </Text>
        <View className="mt-3">
          <Group>
            {bookmarks ? (
              <ActionRow
                testID="import-review-bookmarks"
                icon="bookmark"
                label={bookmarks === 1 ? t("bookmarks.folderOne") : t("bookmarks.folderCount", { count: bookmarks })}
                detail={t("import.review.bookmarksDetail", { folder: folderName })}
                toggle={choice.bookmarks}
                onPress={() => toggle("bookmarks")}
              />
            ) : null}
            {favorites ? (
              <ActionRow
                testID="import-review-favorites"
                icon="pin"
                label={favorites === 1 ? t("import.review.favoriteOne") : t("import.review.favorites", { count: favorites })}
                detail={t("import.review.favoritesDetail")}
                toggle={choice.favorites}
                onPress={() => toggle("favorites")}
              />
            ) : null}
            {history ? (
              <ActionRow
                testID="import-review-history"
                icon="history"
                label={history === 1 ? t("settings.historyOnePage") : t("settings.historyPages", { count: history })}
                detail={history > HISTORY_LIMIT ? t("import.review.historyNewest", { count: HISTORY_LIMIT }) : t("import.review.historyDetail")}
                toggle={choice.history}
                onPress={() => toggle("history")}
              />
            ) : null}
          </Group>
        </View>
        {left ? (
          <Text testID="import-review-left" variant="footnote" tone="muted" className="mt-3">
            {left}
          </Text>
        ) : null}
        <View className="mt-4 flex-row items-center justify-end">
          <PillButton
            testID="import-confirm"
            label={t("import.review.import")}
            accessibilityLabel={t("import.review.importLabel")}
            disabled={!(choice.bookmarks || choice.favorites || choice.history)}
            onPress={() => setStep({ kind: "done", counts: props.onImportExport(step.chosen, choice, folderName) })}
          />
        </View>
      </PanelSheet>
    );
  }

  if (step.kind === "done") {
    const { counts } = step;

    const lines = [
      counts.bookmarks ? (counts.bookmarks === 1 ? t("bookmarks.folderOne") : t("bookmarks.folderCount", { count: counts.bookmarks })) : null,
      counts.favorites ? (counts.favorites === 1 ? t("import.review.favoriteOne") : t("import.review.favorites", { count: counts.favorites })) : null,
      counts.history ? (counts.history === 1 ? t("settings.historyOnePage") : t("settings.historyPages", { count: counts.history })) : null,
    ].filter((line): line is string => line !== null);

    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} title={t("import.done.title")} testID="import-screen" height="80%">
        <View testID="import-done" accessible accessibilityLiveRegion="polite">
          <Text variant="headline">{lines.length ? t("import.done.added") : t("import.done.nothing")}</Text>
          {lines.map((line) => (
            <Text key={line} variant="body" tone="muted" className="mt-1">
              {line}
            </Text>
          ))}
        </View>
        <View className="mt-5 flex-row items-center justify-end gap-2">
          {counts.bookmarks ? (
            <PillButton
              testID="import-show-bookmarks"
              label={t("import.done.showBookmarks")}
              accessibilityLabel={t("import.done.showBookmarks")}
              onPress={props.onShowBookmarks}
            />
          ) : null}
          <PillButton testID="import-finish" label={t("import.done.finish")} accessibilityLabel={t("import.done.finish")} onPress={props.onClose} />
        </View>
      </PanelSheet>
    );
  }

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title={t("import.title")} testID="import-screen" height="85%">
      <Text variant="subhead" tone="muted">
        {t("import.help")}
      </Text>
      <View className="mt-1">
        <Group label={t("import.onThisPhone")} testID="import-browsers">
          {browsers.map((browser) => (
            <ActionRow
              key={browser.id}
              testID={`import-browser-${browser.id}`}
              leading={<BrowserIcon browser={browser} />}
              label={browser.name}
              detail={t(METHOD_DETAIL[browser.method])}
              chevron
              onPress={() => choose(browser)}
            />
          ))}
          <ActionRow
            testID="import-browser-other"
            icon="import"
            label={t("import.another")}
            detail={t("import.method.file")}
            chevron
            onPress={() => choose(ANOTHER)}
          />
          <ActionRow
            testID="import-paste-tabs"
            icon="tabs"
            label={t("import.pasteTabs")}
            detail={t("import.method.paste")}
            chevron
            onPress={() => choose({ ...ANOTHER, method: "paste" })}
          />
        </Group>
      </View>
      <View className="mt-5 bg-default p-4" style={{ borderRadius: radius.card }} testID="import-passwords">
        <Text variant="callout" weight="semibold">
          {t("import.passwords.title")}
        </Text>
        <Text variant="subhead" tone="muted" className="mt-1">
          {t(Platform.OS === "ios" ? "import.passwords.ios" : "import.passwords.android")}
        </Text>
      </View>
    </PanelSheet>
  );
}

/** A browser's own icon on Android; on iOS, which doesn't share other apps' icons, its initial on a tile. */
function BrowserIcon({ browser }: { browser: PhoneBrowser }): JSX.Element {
  if (browser.icon) {
    return <Image source={{ uri: browser.icon }} style={{ width: iconSize.control + 6, height: iconSize.control + 6 }} accessibilityIgnoresInvertColors />;
  }

  return (
    <View
      className="items-center justify-center bg-foreground/10"
      style={{ width: iconSize.control + 6, height: iconSize.control + 6, borderRadius: radius.control - 4 }}
    >
      <Text variant="footnote" weight="semibold">
        {browser.name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** The steps that get a browser's data into a file Bay can open. */
function Guide({ method, name, named }: { method: PhoneBrowser["method"]; name: string; named: boolean }): JSX.Element {
  const t = useT();

  const steps: string[] =
    method === "safari"
      ? [t("import.safari.step1"), t("import.safari.step2"), t("import.safari.step3")]
      : method === "takeout"
        ? [t("import.takeout.step1"), t("import.takeout.step2"), t("import.takeout.step3")]
        : [named ? t("import.file.step1", { name }) : t("import.file.step1Any"), t("import.file.step2"), t("import.file.step3")];

  return (
    <View testID="import-guide" style={{ gap: space.md }}>
      {steps.map((text, index) => (
        <View key={text} className="flex-row" style={{ gap: space.md }}>
          <View className="items-center justify-center rounded-full bg-default" style={{ width: 26, height: 26 }}>
            <Text variant="footnote" weight="semibold">
              {index + 1}
            </Text>
          </View>
          <Text variant="callout" className="flex-1">
            {text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A list of tabs pasted from another browser (Arc Search shares its open tabs as text), opened or archived. */
function PasteTabs({ onImport }: { onImport: ImportPanelProps["onImportTabs"] }): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const t = useT();
  const [text, setText] = useState("");
  const [pasteFailed, setPasteFailed] = useState(false);
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
    <View>
      <Text variant="subhead" tone="muted">
        {t("import.paste.help")}
      </Text>
      <View className="mt-3 bg-default p-3" style={{ borderRadius: radius.tile }}>
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
    </View>
  );
}
