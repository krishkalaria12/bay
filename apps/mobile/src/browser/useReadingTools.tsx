import { hostOf } from "@bay/core/src/input.ts";
import type { Tab } from "@bay/engine";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, useColorScheme, View } from "react-native";
import { useThemeColor } from "heroui-native";
import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { PressFeedback } from "@/chrome/PressFeedback";
import { hiddenFromScreenReaders } from "@/chrome/screenReader";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { radius, space } from "@/chrome/tokens";
import type { Engine } from "@/effect/ports/engine";
import { useScopedWork } from "@/effect/react";
import { useT } from "@/i18n";
import { Toast } from "./Toast";
import { pageScriptFailure, quietly, run, type PageScriptError } from "./pageScripts";
import { INSPECT_SCRIPT, type InspectedElement } from "@/pagescripts/inspect";
import { MARKDOWN_SCRIPT } from "@/pagescripts/markdown";
import { PICK_PARENT_SCRIPT, START_PICKER_SCRIPT, STOP_PICKER_SCRIPT, type PickedElement } from "@/pagescripts/picker";
import { CLOSE_READER_SCRIPT, openReaderScript, updateReaderScript, type ReaderSettings } from "@/pagescripts/reader";
import { InspectPanel } from "@/panels/InspectPanel";
import { useSheetOpen } from "@/panels/openSheets";
import { ReaderPanel } from "@/panels/ReaderPanel";
import { useBrowserStore } from "@/store/browser";
import { siteSettingFor } from "@/store/model";
import type { BrowserTab } from "@/store/types";
import * as v from "valibot";

const pickedMessageSchema = v.object({
  type: v.literal("picked"),
  selector: v.string(),
  label: v.string(),
  tag: v.optional(v.unknown()),
  width: v.optional(v.unknown()),
  height: v.optional(v.unknown()),
});

/** A reading tool that couldn't do its work, with the failure the user reads about. */
class ToolFailed extends TaggedError("ToolFailed")<{
  readonly reason: Error;
}> {}

/** Why a reading tool's work stopped short. */
type ToolError = PageScriptError | ToolFailed;

/** What a reading tool's work needs: the page engine, and the document scope it runs in. */
type ToolWork<A> = Effect.Effect<A, ToolError, Engine | Scope.Scope>;

/** The failure the toast shows for a tool's error. */
const failureOf = (error: ToolError): Error => (error._tag === "ToolFailed" ? error.reason : pageScriptFailure(error));

/** Puts text on the clipboard. */
const copyText = (text: string) =>
  Effect.tryPromise({
    try: () => Clipboard.setStringAsync(text),
    catch: (cause) => new ToolFailed({ reason: cause instanceof Error ? cause : new Error(String(cause)) }),
  });

// Each page view gets a name for the document key, so a view that replaced another starts a new document.
const viewNames = new WeakMap<Tab, number>();
let viewCount = 0;

function viewName(view: Tab | undefined): number {
  if (!view) return 0;

  let name = viewNames.get(view);

  if (name === undefined) {
    viewCount += 1;
    name = viewCount;
    viewNames.set(view, name);
  }

  return name;
}

export function useReadingTools(active: BrowserTab, view: Tab | undefined, isLoading: boolean, blocked: boolean, fail: (cause: unknown) => void) {
  const { data, dispatch } = useBrowserStore();
  const t = useT();
  const [readerTab, setReaderTab] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // The picker either hides what's picked or describes it.
  const [pickMode, setPickMode] = useState<"hide" | "inspect">("hide");
  const [inspected, setInspected] = useState<InspectedElement | null>(null);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [notice, setNotice] = useState("");
  const [privateRules, setPrivateRules] = useState<Record<string, Record<string, string[]>>>({});
  const host = hostOf(active.url);
  const rules = siteRules(active.private ? privateRules[active.id] : data.preferences.hiddenElements, host);
  const reader = readerTab === active.id;
  // Count load starts only: a load finishing keeps the same document, so a tool opened while it loaded stays open.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (isLoading) setLoads((count) => count + 1);
  }, [isLoading]);
  // The document the tools work on. A new document or tab ends a tool session: its work is interrupted, so a late
  // result never lands on the next page, and the tools it opened in the page are closed as its scope ends.
  const documentKey = `${active.id}\n${active.url}\n${loads}\n${blocked}\n${viewName(view)}`;
  const work = useScopedWork(documentKey);
  useEffect(() => {
    setReaderTab(null);
    setSettingsOpen(false);
    setPicking(false);
    setPicked(null);
    setInspected(null);
    setNotice("");
  }, [documentKey]);
  // A defect was reported where failures go; the user still hears that the tool didn't work.
  const outcome = work.result;
  useEffect(() => {
    if (outcome?._tag === "Failed") fail(outcome.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);
  useEffect(() => {
    const ids = new Set(data.tabs.filter((tab) => tab.private).map((tab) => tab.id));
    setPrivateRules((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
  }, [data.tabs]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);

    return () => clearTimeout(timer);
  }, [notice]);

  function script<A>(source: string): Effect.Effect<A, ToolError, Engine> {
    if (blocked) return Effect.fail(new ToolFailed({ reason: new Error(t("notice.unlockFirst")) }));

    if (!view) return Effect.fail(new ToolFailed({ reason: new Error(t("notice.pageNotReady")) }));

    return run<A>(view, source);
  }

  /** Leaves a tool's closing script to run when this document's scope ends, whatever ends it. */
  function closeWhenLeaving(source: string): Effect.Effect<void, never, Engine | Scope.Scope> {
    return view ? Effect.addFinalizer(() => quietly(run(view, source))) : Effect.void;
  }

  /** Runs a tool's work in this document. Its failure reaches the toast; a document that changed says nothing. */
  function task(program: ToolWork<void>): void {
    work.run(program.pipe(Effect.catch((error) => Effect.sync(() => fail(failureOf(error))))));
  }

  function endPicking(): ToolWork<void> {
    return Effect.gen(function* () {
      yield* script(STOP_PICKER_SCRIPT);
      setPicking(false);
      setPicked(null);
      setInspected(null);
    });
  }

  function startPicking(mode: "hide" | "inspect"): void {
    task(
      Effect.gen(function* () {
        if (reader) yield* script(CLOSE_READER_SCRIPT);
        setReaderTab(null);
        // Left before the picker starts, so a picker the page started as the document went is still stopped.
        yield* closeWhenLeaving(STOP_PICKER_SCRIPT);
        yield* script(START_PICKER_SCRIPT);
        setPickMode(mode);
        setPicking(true);
        setPicked(null);
        setInspected(null);
      }),
    );
  }

  /** Opens the details of the picked element. */
  function inspect(): void {
    task(
      Effect.gen(function* () {
        const element = yield* script<InspectedElement | null>(INSPECT_SCRIPT);

        if (element) setInspected(element);
      }),
    );
  }

  function parent(): void {
    task(
      Effect.gen(function* () {
        if (!(yield* script<boolean>(PICK_PARENT_SCRIPT))) setNotice(t("notice.noParent"));
      }),
    );
  }

  function setRules(selectors: string[]): void {
    if (active.private) setPrivateRules((previous) => ({ ...previous, [active.id]: { ...previous[active.id], [host]: selectors } }));
    else dispatch({ type: "hidden-elements", host, selectors });
  }

  function pageMessage(message: string): void {
    if (!picking) return;

    let value: unknown;

    try {
      value = JSON.parse(message);
    } catch {
      // A malformed page message has no action.
      return;
    }

    const parsed = v.safeParse(pickedMessageSchema, value);

    if (!parsed.success) return;

    if (parsed.output.selector.length >= 4096) return;

    const tag = v.is(v.string(), parsed.output.tag) ? parsed.output.tag.slice(0, 40) : "";
    const width = v.is(v.number(), parsed.output.width) && Number.isFinite(parsed.output.width) ? Math.round(parsed.output.width) : 0;
    const height = v.is(v.number(), parsed.output.height) && Number.isFinite(parsed.output.height) ? Math.round(parsed.output.height) : 0;

    setPicked({ type: "picked", selector: parsed.output.selector, label: parsed.output.label.slice(0, 200), tag, width, height });

    if (pickMode === "inspect") inspect();
  }

  /** Turns Reader on for this page; when it already reads, it only opens (or keeps closed) its settings panel. */
  function turnReaderOn(openSettings: boolean): ToolWork<boolean> {
    return Effect.gen(function* () {
      if (reader) {
        if (openSettings) setSettingsOpen(true);

        return true;
      }

      if (picking) yield* endPicking();
      yield* closeWhenLeaving(CLOSE_READER_SCRIPT);

      const result = yield* script<{ ok: boolean }>(openReaderScript(data.preferences.reader));

      if (!result.ok) return false;

      setReaderTab(active.id);

      if (openSettings) setSettingsOpen(true);

      return true;
    });
  }

  function exitReader(): void {
    task(
      Effect.gen(function* () {
        yield* script(CLOSE_READER_SCRIPT);
        setReaderTab(null);
        setSettingsOpen(false);
      }),
    );
  }

  // A site that keeps Reader open (B12): as each page here finishes loading, Reader opens by itself — once per
  // address, so coming back later stays quiet, and nothing pops while the page is still loading or locked.
  const autoReaderUrl = useRef<string | null>(null);
  useEffect(() => {
    const wanted = siteSettingFor(data.preferences.siteSettings, active.url).reader;

    if (!wanted || reader || isLoading || !active.url || blocked || !view) return;

    if (autoReaderUrl.current === active.url) return;
    autoReaderUrl.current = active.url;

    const tabId = active.id;
    work.run(
      quietly(
        Effect.gen(function* () {
          yield* closeWhenLeaving(CLOSE_READER_SCRIPT);

          const result = yield* run<{ ok: boolean }>(view, openReaderScript(data.preferences.reader));

          if (result.ok) setReaderTab(tabId);
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.url, reader, isLoading, blocked, view]);

  function changeSettings(settings: ReaderSettings): void {
    dispatch({ type: "reader-settings", settings });
    task(Effect.asVoid(script(updateReaderScript(settings))));
  }

  return {
    reader,
    picking,
    /** Android Back: closes the innermost reading tool. False when none is open. */
    back(): boolean {
      if (settingsOpen) setSettingsOpen(false);
      else if (inspected) setInspected(null);
      else if (picking) task(endPicking());
      else return false;

      return true;
    },
    selectorsFor(tab: BrowserTab): string[] {
      const site = hostOf(tab.url);

      return siteRules(tab.private ? privateRules[tab.id] : data.preferences.hiddenElements, site);
    },
    pageMessage,
    /** Brings back everything hidden on the current site. */
    showHidden: () => setRules([]),
    openReader: () =>
      task(
        Effect.gen(function* () {
          if (!(yield* turnReaderOn(true))) setNotice(t("notice.noArticle"));
        }),
      ),
    /** Left from the site's panel (B12): Reader goes off even when this site asked for it. */
    closeReader: exitReader,
    copyMarkdown: () =>
      task(
        Effect.gen(function* () {
          const result = yield* script<{ markdown: string }>(MARKDOWN_SCRIPT);

          yield* copyText(result.markdown);
          setNotice(t("notice.markdownCopied"));
        }),
      ),
    startPicking: () => startPicking("hide"),
    startInspecting: () => startPicking("inspect"),
    controls: (
      <>
        <ReaderPanel
          visible={settingsOpen && reader}
          settings={data.preferences.reader}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
          onExit={exitReader}
        />
        <InspectPanel
          element={picking && pickMode === "inspect" ? inspected : null}
          title={picked?.label}
          onClose={() => setInspected(null)}
          onParent={parent}
          onCopy={() =>
            task(
              Effect.gen(function* () {
                if (!inspected) return;

                yield* copyText(inspected.agent);
                setNotice(t("notice.copiedForAgent"));
              }),
            )
          }
        />
        {picking && pickMode === "inspect" ? (
          <PickerCard testID="inspect-instructions" icon="inspect" picked={picked} hint={t("picker.inspectHint")}>
            {picked ? <ToolButton id="inspect-parent-pick" label={t("picker.parent")} icon="up" onPress={parent} /> : null}
            {picked ? <ToolButton id="inspect-open" label={t("picker.details")} primary onPress={inspect} /> : null}
            <ToolButton id="inspect-done" label={t("picker.done")} onPress={() => task(endPicking())} />
          </PickerCard>
        ) : null}
        {picking && pickMode === "hide" ? (
          <PickerCard testID="hide-instructions" icon="hide" picked={picked} hint={t("picker.hideHint")}>
            {picked ? <ToolButton id="hide-parent" label={t("picker.parent")} icon="up" onPress={parent} /> : null}
            {picked ? (
              <ToolButton
                id="hide-zap"
                label={t("picker.hide")}
                primary
                onPress={() => {
                  setRules([...new Set([...rules, picked.selector])]);
                  setPicked(null);
                }}
              />
            ) : (
              <>
                <ToolButton id="hide-undo" label={t("picker.undo")} disabled={!rules.length} onPress={() => setRules(rules.slice(0, -1))} />
                <ToolButton id="hide-reset" label={t("picker.resetSite")} disabled={!rules.length} onPress={() => setRules([])} />
              </>
            )}
            <ToolButton id="hide-done" label={t("picker.done")} onPress={() => task(endPicking())} />
          </PickerCard>
        ) : null}
        {notice ? <Toast key={notice} text={notice} testID="reading-notice" /> : null}
      </>
    ),
  };
}

/** The picker's floating card: what's picked, in words, with its tag and size, over a row of actions. */
function PickerCard({
  testID,
  icon,
  picked,
  hint,
  children,
}: {
  testID: string;
  icon: IconName;
  picked: PickedElement | null;
  hint: string;
  children: ReactNode;
}) {
  const accent = useThemeColor("accent");
  const t = useT();
  // Behind an open sheet (the inspector's details) the card steps out of screen readers' way, like the bar.
  const behindSheet = hiddenFromScreenReaders(useSheetOpen());
  // Android's surfaces are translucent; over page text that hurts reading, so this card is solid there.
  const solid = useColorScheme() === "dark" ? "#171717" : "#FFFFFF";

  return (
    <View collapsable={false} {...behindSheet}>
      <Surface radius={radius.card} style={[{ padding: 14, gap: space.md }, Platform.OS === "android" && { backgroundColor: solid }]}>
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-full bg-accent/15">
            <Icon name={icon} color={accent} size={20} />
          </View>
          <View className="flex-1">
            <Text testID={testID} numberOfLines={1} accessibilityLiveRegion="polite" variant="callout" weight="medium">
              {picked ? picked.label : hint}
            </Text>
            <Text numberOfLines={1} variant="footnote" tone="muted" style={{ marginTop: 1 }}>
              {picked ? `${picked.tag} · ${picked.width} × ${picked.height}` : t("picker.linksClosed")}
            </Text>
          </View>
        </View>
        <View className="flex-row gap-2">{children}</View>
      </Surface>
    </View>
  );
}

function ToolButton({
  id,
  label,
  icon,
  primary,
  disabled,
  onPress,
}: {
  id: string;
  label: string;
  icon?: IconName;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const foreground = useThemeColor("foreground");
  const accentForeground = useThemeColor("accent-foreground");

  return (
    <PressFeedback
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        primary
          ? "h-11 flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-accent px-3"
          : "h-11 flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-default px-3"
      }
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {icon ? <Icon name={icon} color={primary ? accentForeground : foreground} size={18} /> : null}
      <Text variant="callout" weight={primary ? "semibold" : "regular"} color={primary ? accentForeground : foreground} numberOfLines={1}>
        {label}
      </Text>
    </PressFeedback>
  );
}

function siteRules(table: Record<string, string[]> | undefined, host: string): string[] {
  return table && Object.hasOwn(table, host) ? table[host]! : [];
}
