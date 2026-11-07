import { hostOf } from "@bay/core/src/input.ts";
import { runPageScript, type Tab } from "@bay/engine";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, useColorScheme, View } from "react-native";
import { useThemeColor } from "heroui-native";
import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { Surface } from "@/chrome/Surface";
import { Toast } from "./Toast";
import { INSPECT_SCRIPT, type InspectedElement } from "@/pagescripts/inspect";
import { MARKDOWN_SCRIPT } from "@/pagescripts/markdown";
import { PICK_PARENT_SCRIPT, START_PICKER_SCRIPT, STOP_PICKER_SCRIPT, type PickedElement } from "@/pagescripts/picker";
import { CLOSE_READER_SCRIPT, openReaderScript, updateReaderScript, type ReaderSettings } from "@/pagescripts/reader";
import { InspectPanel } from "@/panels/InspectPanel";
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

export function useReadingTools(active: BrowserTab, view: Tab | undefined, isLoading: boolean, blocked: boolean, fail: (cause: unknown) => void) {
  const { data, dispatch } = useBrowserStore();
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
  const context = useRef(0);
  // Count load starts only: a load finishing keeps the same document, so a tool opened while it loaded stays open.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (isLoading) setLoads((count) => count + 1);
  }, [isLoading]);
  // A new document or tab ends a tool session. Ignore late results from the previous document.
  useEffect(() => {
    context.current++;
    setReaderTab(null);
    setSettingsOpen(false);
    setPicking(false);
    setPicked(null);
    setInspected(null);
    setNotice("");

    return () => {
      if (view) {
        void runPageScript(view, STOP_PICKER_SCRIPT).catch(() => {});
        void runPageScript(view, CLOSE_READER_SCRIPT).catch(() => {});
      }
    };
  }, [active.id, active.url, loads, view, blocked]);
  useEffect(() => {
    const ids = new Set(data.tabs.filter((tab) => tab.private).map((tab) => tab.id));
    setPrivateRules((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
  }, [data.tabs]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);

    return () => clearTimeout(timer);
  }, [notice]);

  async function script<T>(source: string): Promise<T> {
    if (blocked) throw new Error("Unlock private tabs first.");

    if (!view) throw new Error("The page isn't ready.");
    const version = context.current;
    const result = await runPageScript<T>(view, source);

    if (context.current !== version) throw new Error("The page changed.");

    return result;
  }

  function task(action: () => Promise<void>): void {
    const version = context.current;
    void action().catch((cause) => {
      if (context.current === version) fail(cause);
    });
  }

  async function endPicking(): Promise<void> {
    await script(STOP_PICKER_SCRIPT);
    setPicking(false);
    setPicked(null);
    setInspected(null);
  }

  function startPicking(mode: "hide" | "inspect"): void {
    task(async () => {
      if (reader) await script(CLOSE_READER_SCRIPT);
      setReaderTab(null);
      const version = context.current;
      await script(START_PICKER_SCRIPT);

      if (context.current !== version) return;
      setPickMode(mode);
      setPicking(true);
      setPicked(null);
      setInspected(null);
    });
  }

  /** Opens the details of the picked element. */
  function inspect(): void {
    task(async () => {
      const element = await script<InspectedElement | null>(INSPECT_SCRIPT);

      if (element) setInspected(element);
    });
  }

  function parent(): void {
    task(async () => {
      if (!(await script<boolean>(PICK_PARENT_SCRIPT))) setNotice("No larger element to select.");
    });
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
  async function turnReaderOn(openSettings: boolean): Promise<boolean> {
    if (reader) {
      if (openSettings) setSettingsOpen(true);

      return true;
    }

    const version = context.current;

    if (picking) await endPicking();
    const result = await script<{ ok: boolean }>(openReaderScript(data.preferences.reader));

    if (context.current !== version) return true;

    if (!result.ok) return false;

    setReaderTab(active.id);
    if (openSettings) setSettingsOpen(true);

    return true;
  }

  // A site that keeps Reader open (B12): as each page here finishes loading, Reader opens by itself — once per
  // address, so coming back later stays quiet, and nothing pops while the page is still loading or locked.
  const autoReaderUrl = useRef<string | null>(null);
  useEffect(() => {
    const wanted = siteSettingFor(data.preferences.siteSettings, active.url).reader;

    if (!wanted || reader || isLoading || !active.url || blocked || !view) return;
    if (autoReaderUrl.current === active.url) return;
    autoReaderUrl.current = active.url;

    const version = context.current;
    void (async () => {
      const result = await runPageScript<{ ok: boolean }>(view, openReaderScript(data.preferences.reader));

      if (context.current === version && result.ok) setReaderTab(active.id);
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.url, reader, isLoading, blocked, view]);

  function changeSettings(settings: ReaderSettings): void {
    dispatch({ type: "reader-settings", settings });
    task(async () => {
      await script(updateReaderScript(settings));
    });
  }

  return {
    reader,
    picking,
    /** Android Back: closes the innermost reading tool. False when none is open. */
    back(): boolean {
      if (settingsOpen) setSettingsOpen(false);
      else if (inspected) setInspected(null);
      else if (picking) task(endPicking);
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
      task(async () => {
        if (!(await turnReaderOn(true))) setNotice("No article found on this page.");
      }),
    /** Left from the site's panel (B12): Reader goes off even when this site asked for it. */
    closeReader: () =>
      task(async () => {
        await script(CLOSE_READER_SCRIPT);
        setReaderTab(null);
        setSettingsOpen(false);
      }),
    copyMarkdown: () =>
      task(async () => {
        const result = await script<{ markdown: string }>(MARKDOWN_SCRIPT);
        await Clipboard.setStringAsync(result.markdown);
        setNotice("Markdown copied.");
      }),
    startPicking: () => startPicking("hide"),
    startInspecting: () => startPicking("inspect"),
    controls: (
      <>
        <ReaderPanel
          visible={settingsOpen && reader}
          settings={data.preferences.reader}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
          onExit={() =>
            task(async () => {
              await script(CLOSE_READER_SCRIPT);
              setReaderTab(null);
              setSettingsOpen(false);
            })
          }
        />
        <InspectPanel
          element={picking && pickMode === "inspect" ? inspected : null}
          title={picked?.label}
          onClose={() => setInspected(null)}
          onParent={parent}
          onCopy={() =>
            task(async () => {
              if (!inspected) return;
              await Clipboard.setStringAsync(inspected.agent);
              setNotice("Copied for a coding agent.");
            })
          }
        />
        {picking && pickMode === "inspect" ? (
          <PickerCard testID="inspect-instructions" icon="inspect" picked={picked} hint="Tap an element to inspect it.">
            {picked ? <ToolButton id="inspect-parent-pick" label="Parent" icon="up" onPress={parent} /> : null}
            {picked ? <ToolButton id="inspect-open" label="Details" primary onPress={inspect} /> : null}
            <ToolButton id="inspect-done" label="Done" onPress={() => task(endPicking)} />
          </PickerCard>
        ) : null}
        {picking && pickMode === "hide" ? (
          <PickerCard testID="hide-instructions" icon="hide" picked={picked} hint="Tap an element to hide it.">
            {picked ? <ToolButton id="hide-parent" label="Parent" icon="up" onPress={parent} /> : null}
            {picked ? (
              <ToolButton
                id="hide-zap"
                label="Hide"
                primary
                onPress={() => {
                  setRules([...new Set([...rules, picked.selector])]);
                  setPicked(null);
                }}
              />
            ) : (
              <>
                <ToolButton id="hide-undo" label="Undo" disabled={!rules.length} onPress={() => setRules(rules.slice(0, -1))} />
                <ToolButton id="hide-reset" label="Reset site" disabled={!rules.length} onPress={() => setRules([])} />
              </>
            )}
            <ToolButton id="hide-done" label="Done" onPress={() => task(endPicking)} />
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
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const accent = useThemeColor("accent");
  // Android's surfaces are translucent; over page text that hurts reading, so this card is solid there.
  const solid = useColorScheme() === "dark" ? "#171717" : "#FFFFFF";

  return (
    <Surface radius={26} style={[{ padding: 14, gap: 12 }, Platform.OS === "android" && { backgroundColor: solid }]}>
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-accent/15">
          <Icon name={icon} color={accent} size={20} />
        </View>
        <View className="flex-1">
          <Text testID={testID} numberOfLines={1} style={{ color: foreground, fontSize: 15.5, fontWeight: "500" }}>
            {picked ? picked.label : hint}
          </Text>
          <Text numberOfLines={1} style={{ color: muted, fontSize: 12.5, marginTop: 1 }}>
            {picked ? `${picked.tag} · ${picked.width} × ${picked.height}` : "Links don't open while you pick."}
          </Text>
        </View>
      </View>
      <View className="flex-row gap-2">{children}</View>
    </Surface>
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
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        primary
          ? "h-11 flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-accent px-3 active:opacity-80"
          : "h-11 flex-1 flex-row items-center justify-center gap-1.5 rounded-full bg-default px-3 active:opacity-70"
      }
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {icon ? <Icon name={icon} color={primary ? accentForeground : foreground} size={18} /> : null}
      <Text numberOfLines={1} style={{ color: primary ? accentForeground : foreground, fontSize: 15, fontWeight: primary ? "600" : "400" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function siteRules(table: Record<string, string[]> | undefined, host: string): string[] {
  return table && Object.hasOwn(table, host) ? table[host]! : [];
}
