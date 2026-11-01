import { hostOf } from "@bay/core/src/omnibox.ts";
import { runPageScript, type Tab } from "@bay/engine";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Surface } from "@/chrome/Surface";
import { Toast } from "./Toast";
import { INSPECT_SCRIPT, type InspectedElement } from "@/pagescripts/inspect";
import { MARKDOWN_SCRIPT } from "@/pagescripts/markdown";
import { PICK_PARENT_SCRIPT, START_PICKER_SCRIPT, STOP_PICKER_SCRIPT, type PickedElement } from "@/pagescripts/picker";
import { CLOSE_READER_SCRIPT, openReaderScript, updateReaderScript, type ReaderSettings } from "@/pagescripts/reader";
import { InspectPanel } from "@/panels/InspectPanel";
import { ReaderPanel } from "@/panels/ReaderPanel";
import { useBrowserStore } from "@/store/browser";
import type { BrowserTab } from "@/store/types";

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
  function setRules(selectors: string[]): void {
    if (active.private) setPrivateRules((previous) => ({ ...previous, [active.id]: { ...previous[active.id], [host]: selectors } }));
    else dispatch({ type: "hidden-elements", host, selectors });
  }
  function pageMessage(message: string): void {
    if (!picking) return;
    try {
      const value: unknown = JSON.parse(message);
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "picked" &&
        "selector" in value &&
        typeof value.selector === "string" &&
        value.selector.length < 4096 &&
        "label" in value &&
        typeof value.label === "string"
      ) {
        setPicked({ type: "picked", selector: value.selector, label: value.label.slice(0, 200) });
        if (pickMode === "inspect") inspect();
      }
    } catch {
      /* A malformed page message has no action. */
    }
  }
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
    openReader: () =>
      task(async () => {
        if (reader) {
          setSettingsOpen(true);
          return;
        }
        const version = context.current;
        if (picking) await endPicking();
        const result = await script<{ ok: boolean }>(openReaderScript(data.preferences.reader));
        if (context.current !== version) return;
        if (!result.ok) {
          setNotice("No article found on this page.");
          return;
        }
        setReaderTab(active.id);
        setSettingsOpen(true);
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
          onClose={() => setInspected(null)}
          onParent={() =>
            task(async () => {
              if (!(await script<boolean>(PICK_PARENT_SCRIPT))) setNotice("No larger element to select.");
            })
          }
          onCopy={() =>
            task(async () => {
              if (!inspected) return;
              await Clipboard.setStringAsync(inspected.agent);
              setNotice("Copied for a coding agent.");
            })
          }
        />
        {picking && pickMode === "inspect" ? (
          <Surface radius={18} style={{ padding: 12 }}>
            <Text className="text-foreground" testID="inspect-instructions">
              {picked ? picked.label : "Tap an element to inspect it."}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {picked ? <ToolButton id="inspect-open" label="Details" onPress={inspect} /> : null}
              <ToolButton id="inspect-done" label="Done" onPress={() => task(endPicking)} />
            </View>
          </Surface>
        ) : null}
        {picking && pickMode === "hide" ? (
          <Surface radius={18} style={{ padding: 12 }}>
            <Text className="text-foreground" testID="hide-instructions">
              {picked ? picked.label : "Tap an element to hide it."}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {picked ? (
                <ToolButton
                  id="hide-zap"
                  label="Zap"
                  onPress={() => {
                    setRules([...new Set([...rules, picked.selector])]);
                    setPicked(null);
                  }}
                />
              ) : null}
              {picked ? (
                <ToolButton
                  id="hide-parent"
                  label="Parent"
                  onPress={() =>
                    task(async () => {
                      if (!(await script<boolean>(PICK_PARENT_SCRIPT))) setNotice("No larger element to select.");
                    })
                  }
                />
              ) : null}
              <ToolButton id="hide-undo" label="Undo" disabled={!rules.length} onPress={() => setRules(rules.slice(0, -1))} />
              <ToolButton id="hide-reset" label="Reset site" disabled={!rules.length} onPress={() => setRules([])} />
              <ToolButton id="hide-done" label="Done" onPress={() => task(endPicking)} />
            </View>
          </Surface>
        ) : null}
        {notice ? <Toast key={notice} text={notice} testID="reading-notice" /> : null}
      </>
    ),
  };
}
function ToolButton({ id, label, disabled, onPress }: { id: string; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-default px-3"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className="text-foreground">{label}</Text>
    </Pressable>
  );
}

function siteRules(table: Record<string, string[]> | undefined, host: string): string[] {
  return table && Object.hasOwn(table, host) ? table[host]! : [];
}
