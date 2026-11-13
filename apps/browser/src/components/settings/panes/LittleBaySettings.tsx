import { updateSettings } from "../../../runtime/settingsActions";
import { reportBrowserCommand } from "../../../runtime/commands";
import { isMac } from "@bay/platform";
import type { HotKeyStatus, MenuShortcut } from "@bay/desktop";
import { useEffect, useRef, useState } from "react";
import { menuShortcuts } from "../../../lib/keyBindings";
import { useBrowserRead as useBrowser } from "../../../store/read";
import type { LittleBayShortcut } from "../../../store/settings";
import { DEFAULT_LITTLE_BAY_SHORTCUT, useLittleBayAccess } from "../../littleBay/access";
import { Group, PopUp, Row, SectionHeader, SettingToggle, Toggle } from "../controls";
import { SETTINGS } from "../definitions";
import { comboId, formatShortcut, ShortcutField } from "./Shortcuts";
import { withWorkflows } from "../settingsCommands";

// The recorder this pane is: closing it stops its own recording, and no other pane's.
const RECORDER = "littleBay";

const PUT_AWAY_CHOICES = [
  { value: "1", title: "After 1 hour" },
  { value: "6", title: "After 6 hours" },
  { value: "12", title: "After 12 hours" },
  { value: "24", title: "After 24 hours" },
  { value: "never", title: "Never" },
];

// Little Bay, as Little Arc: from any app with a shortcut or the menu bar, and put away once left alone.
export function LittleBaySettings() {
  const shortcut = useBrowser((s) => s.settings.littleBayShortcut);
  const hours = useBrowser((s) => s.settings.littleBayPutAwayAfterHours);
  const status = useLittleBayAccess((a) => a.status);
  const overrides = useBrowser((s) => s.settings.shortcuts);
  const update = (patch: Parameters<typeof updateSettings>[0]) => reportBrowserCommand(updateSettings(patch));
  const [recording, setRecording] = useState(false);
  const latestRecording = useRef(0);
  const [menus, setMenus] = useState<MenuShortcut[]>([]);
  useEffect(() => {
    void menuShortcuts().then(setMenus);

    // The pane's recording stops with the pane.
    return () => void withWorkflows((w) => w.stopRecording(RECORDER));
  }, []);

  const record = async () => {
    const run = ++latestRecording.current;
    setRecording(true);
    const combo = await withWorkflows((w) => w.record(RECORDER));

    // A later recording replaced this one, and its field stays lit.
    if (run === latestRecording.current) setRecording(false);
    // A global shortcut needs ⌘, ⌥ or ⌃: a bare key or ⇧ and a key would take typing from every app.
    const modifiers = (combo?.modifiers ?? []).filter((m): m is LittleBayShortcut["modifiers"][number] => m !== "function");

    if (!combo || !modifiers.some((m) => m !== "shift")) return;
    update({ littleBayShortcut: { key: combo.key, keyCode: combo.keyCode, modifiers } });
  };

  // Bay's own menu item with the same keys (not New Little Bay Window, which is the same thing): the shortcut wins.
  const clash = shortcut
    ? menus.find((item) => {
        const own = overrides[item.id];
        const combo = own ? { key: own[0] ?? "", modifiers: own.slice(1) } : { key: item.defaultKey, modifiers: item.defaultModifiers };

        return item.title !== "New Little Bay Window" && comboId(combo) === comboId(shortcut);
      })
    : undefined;

  // A time chosen elsewhere (not one of the choices) stays listed, as itself.
  const hoursValue = hours === null ? "never" : String(hours);

  const putAwayChoices = PUT_AWAY_CHOICES.some((c) => c.value === hoursValue)
    ? PUT_AWAY_CHOICES
    : [...PUT_AWAY_CHOICES, { value: hoursValue, title: `After ${hours} hours` }];

  return (
    <>
      <SectionHeader title="Little Bay" />
      <Group>
        <Row settingId={SETTINGS.littleBayShortcut.id} title={SETTINGS.littleBayShortcut.title} description={shortcutDescription(shortcut, status, clash)}>
          {shortcut ? (
            <ShortcutField
              combo={shortcut}
              remappable
              recording={recording}
              onRecord={() => void record()}
              onClear={() => update({ littleBayShortcut: null })}
            />
          ) : null}
          <Toggle value={!!shortcut} onChange={(on) => update({ littleBayShortcut: on ? DEFAULT_LITTLE_BAY_SHORTCUT : null })} />
        </Row>
        <SettingToggle
          setting="littleBayMenuBarItem"
          settingId={SETTINGS.littleBayMenuBarItem.id}
          title={SETTINGS.littleBayMenuBarItem.title}
          description={isMac ? "A button in the menu bar that opens Little Bay." : "An icon in the system tray that opens Little Bay."}
        />
        <Row
          settingId={SETTINGS.littleBayPutAwayAfterHours.id}
          title={SETTINGS.littleBayPutAwayAfterHours.title}
          description="A Little Bay you've left alone closes. Its page is in the Library's archive, under Little Bay."
        >
          <PopUp
            value={hoursValue}
            options={putAwayChoices}
            onChange={(value) => update({ littleBayPutAwayAfterHours: value === "never" ? null : Number(value) })}
            minWidth={150}
          />
        </Row>
      </Group>
    </>
  );
}

function shortcutDescription(shortcut: { key: string; modifiers: readonly string[] } | null, status: HotKeyStatus, clash: MenuShortcut | undefined): string {
  if (!shortcut) return "A shortcut that opens Little Bay ready to type, even when Bay is in the background.";
  const keys = formatShortcut(shortcut);

  if (status === "taken") return `${keys} is taken by another app or by ${isMac ? "macOS" : "your desktop"}. Choose another.`;

  if (status === "unavailable") return "Your desktop doesn't let apps use a shortcut from anywhere. Use the tray icon, or the shortcut inside Bay.";

  if (clash) return `Also Bay's ${clash.title}: in Bay, ${keys} opens Little Bay instead.`;

  return `${keys} opens Little Bay ready to type, from any app.`;
}
