import { Typography } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

export interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  engines: readonly { id: string; name: string }[];
  searchEngineId: string;
  onSearchEngineChange: (id: string) => void;
  archiveAfterDays: number | null;
  onArchiveAfterDaysChange: (days: number | null) => void;
  blockContent: boolean;
  /** What the blocker is doing, shown under its switch. */
  blockerDetail: string;
  onBlockContentChange: (enabled: boolean) => void;
  /** Hidden when the engine can't keep private tabs. */
  privateAvailable: boolean;
  lockPrivateTabs: boolean;
  onLockPrivateTabsChange: (enabled: boolean) => void;
  onClearData: () => Promise<void>;
  downloadCount: number;
  onDownloads: () => void;
}

const archiveOptions = [
  { days: 1, label: "After 1 day" },
  { days: 7, label: "After 7 days" },
  { days: 30, label: "After 30 days" },
  { days: null, label: "Never" },
];

// The sheet stays mounted and toggles open, like the other panels; each opening starts a fresh confirmation.
export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The engine list stays folded so the rest of Settings fits without scrolling.
  const [choosingEngine, setChoosingEngine] = useState(false);
  const [choosingArchive, setChoosingArchive] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!props.visible) return;
    setConfirming(false);
    setChoosingEngine(false);
    setChoosingArchive(false);
    setError(null);
  }, [props.visible]);

  async function clearData(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onClearData();
      if (!mounted.current) return;
      setConfirming(false);
      // The empty start page behind the sheet shows the result.
      props.onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't clear browsing data. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Settings" testID="settings-screen" height="85%" dismissible={!busy}>
      <SectionLabel>Search</SectionLabel>
      <ActionRow
        testID="settings-engine"
        label="Search engine"
        detail={props.engines.find((engine) => engine.id === props.searchEngineId)?.name}
        disabled={busy}
        onPress={() => setChoosingEngine((open) => !open)}
      />
      {choosingEngine
        ? props.engines.map((engine) => (
            <ActionRow
              key={engine.id}
              testID={`settings-engine-${engine.id}`}
              label={engine.name}
              selected={engine.id === props.searchEngineId}
              disabled={busy}
              onPress={() => {
                props.onSearchEngineChange(engine.id);
                setChoosingEngine(false);
              }}
            />
          ))
        : null}
      <SectionLabel>Privacy</SectionLabel>
      <ActionRow
        testID="settings-block-content"
        label="Block ads and trackers"
        detail={props.blockerDetail}
        selected={props.blockContent}
        disabled={busy}
        onPress={() => props.onBlockContentChange(!props.blockContent)}
      />
      {props.privateAvailable ? (
        <ActionRow
          testID="settings-lock-private"
          label="Lock private tabs"
          detail="Face ID, Touch ID or passcode"
          selected={props.lockPrivateTabs}
          disabled={busy}
          onPress={() => props.onLockPrivateTabsChange(!props.lockPrivateTabs)}
        />
      ) : null}
      <SectionLabel>Tabs</SectionLabel>
      <ActionRow
        testID="settings-archive"
        label="Archive inactive tabs"
        detail={archiveOptions.find((option) => option.days === props.archiveAfterDays)?.label}
        disabled={busy}
        onPress={() => setChoosingArchive((open) => !open)}
      />
      {choosingArchive ? (
        <>
          <Typography className="text-sm text-muted">Your current tab stays open. You can restore archived tabs at any time.</Typography>
          {archiveOptions.map((option) => (
            <ActionRow
              key={option.days ?? "never"}
              testID={`settings-archive-${option.days ?? "never"}`}
              label={option.label}
              selected={props.archiveAfterDays === option.days}
              disabled={busy}
              onPress={() => {
                props.onArchiveAfterDaysChange(option.days);
                setChoosingArchive(false);
              }}
            />
          ))}
        </>
      ) : null}
      <SectionLabel>Browsing data</SectionLabel>
      {confirming ? (
        <View testID="clear-data-confirmation">
          <ActionRow
            testID="clear-data-confirm"
            label={busy ? "Clearing data…" : "Clear all browsing data"}
            detail="Tabs, archive, history, pins, cookies and website data. Settings stay."
            destructive
            disabled={busy}
            onPress={() => {
              void clearData();
            }}
          />
          <ActionRow testID="clear-data-cancel" label="Keep browsing data" disabled={busy} onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <ActionRow
          testID="settings-clear-data"
          label="Clear browsing data"
          destructive
          disabled={busy}
          onPress={() => {
            setConfirming(true);
            setError(null);
          }}
        />
      )}
      <ActionRow
        testID="settings-downloads"
        label="Downloads"
        detail={props.downloadCount ? `${props.downloadCount} ${props.downloadCount === 1 ? "file" : "files"}` : undefined}
        disabled={busy}
        onPress={props.onDownloads}
      />
      {busy ? (
        <Typography testID="clear-data-busy" className="mt-3 text-sm text-muted">
          Clearing website data…
        </Typography>
      ) : null}
      {error ? (
        <Typography testID="clear-data-error" accessibilityRole="alert" className="mt-3 text-sm text-danger">
          {error}
        </Typography>
      ) : null}
    </PanelSheet>
  );
}
