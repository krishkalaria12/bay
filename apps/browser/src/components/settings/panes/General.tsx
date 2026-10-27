import { View, isMac, shortcutLabel } from "@bay/platform";
import {
  checkForUpdates,
  isDefaultBrowser,
  launchAtLoginStatus,
  setAsDefaultBrowser,
  setAutomaticUpdateChecks,
  setAutomaticUpdateDownloads,
  setLaunchAtLogin,
  Symbol,
  tidyNames,
  updaterState,
  type UpdaterState,
} from "@bay/shell";
import { useEffect, useState } from "react";
import { AppState, Text } from "react-native";
import { reportBrowserCommand } from "../../../runtime/commands";
import { updateSettings } from "../../../runtime/settingsActions";
import { useBrowserRead } from "../../../store/read";
import { useTheme } from "../../../lib/theme";
import { SHARING_COPY } from "../../../telemetry/copy";
import { Button, Group, PopUp, Row, SectionHeader, SettingToggle, Toggle, useFormColors } from "../controls";
import { SETTINGS } from "../definitions";
import { openImport } from "../windows";
import { APP_NAME } from "../../../lib/constants";

export function GeneralPane() {
  const settings = useBrowserRead((s) => s.settings);
  const [loginStatus, setLoginStatus] = useState<string>("notRegistered");

  const refreshLogin = () => void launchAtLoginStatus().then(setLoginStatus);
  useEffect(refreshLogin, []);

  return (
    <View>
      <DefaultBrowserBanner />

      <SectionHeader title="General" />
      <Group>
        <Row
          settingId={SETTINGS.launchAtLogin.id}
          title={SETTINGS.launchAtLogin.title}
          description={loginStatus === "requiresApproval" ? "Allow it in System Settings › General › Login Items." : undefined}
        >
          <Toggle
            value={loginStatus === "enabled" || loginStatus === "requiresApproval"}
            onChange={(on) =>
              void setLaunchAtLogin(on)
                .catch(() => {})
                .finally(refreshLogin)
            }
          />
        </Row>
        <Row
          settingId={SETTINGS.warnBeforeQuitting.id}
          title={SETTINGS.warnBeforeQuitting.title}
          description={isMac ? `Asks before ${APP_NAME} quits with ⌘Q.` : `Asks before ${APP_NAME} quits.`}
        >
          <Toggle value={settings.warnBeforeQuitting} onChange={(v) => reportBrowserCommand(updateSettings({ warnBeforeQuitting: v }))} />
        </Row>
        <Row
          settingId={SETTINGS.warnBeforeClosingWindow.id}
          title={SETTINGS.warnBeforeClosingWindow.title}
          description={shortcutLabel("Asks before ⇧⌘W or the close button closes its tabs.")}
        >
          <Toggle value={settings.warnBeforeClosingWindow} onChange={(v) => reportBrowserCommand(updateSettings({ warnBeforeClosingWindow: v }))} />
        </Row>
      </Group>

      <SectionHeader title={`When opening ${APP_NAME}:`} />
      <Group>
        <Row settingId={SETTINGS.launchTab.id} title={SETTINGS.launchTab.title} description="Your tabs stay in the sidebar either way.">
          <PopUp
            value={settings.launchTab}
            options={[
              { value: "newTab", title: "A new tab" },
              { value: "lastTab", title: "The last tab you viewed" },
            ]}
            onChange={(v) => reportBrowserCommand(updateSettings({ launchTab: v }))}
            minWidth={190}
          />
        </Row>
      </Group>

      <SectionHeader title={`When quitting ${APP_NAME}:`} />
      <Group>
        <Row
          settingId={SETTINGS.restoreSession.id}
          title={SETTINGS.restoreSession.title}
          description="What you see the next time you open it. Closed windows stay in History › Recently Closed."
        >
          <PopUp
            value={settings.restoreSession ? "keep" : "close"}
            options={[
              { value: "keep", title: "Preserve tabs and windows" },
              { value: "close", title: "Start fresh" },
            ]}
            onChange={(v) => reportBrowserCommand(updateSettings({ restoreSession: v === "keep" }))}
            minWidth={190}
          />
        </Row>
      </Group>

      <SectionHeader title="Command bar" description="What happens when what you type could be a website or a search." />
      <Group>
        <Row settingId={SETTINGS.commandBarPreference.id} title={SETTINGS.commandBarPreference.title}>
          <PopUp
            value={settings.commandBarPreference}
            options={[
              { value: "website", title: "Use Website First" },
              { value: "search", title: "Prefer Search Engine" },
            ]}
            onChange={(v) => reportBrowserCommand(updateSettings({ commandBarPreference: v }))}
            minWidth={190}
          />
        </Row>
      </Group>

      <UpdatesSection />

      <SectionHeader title="Import" />
      <Group>
        <Row
          settingId={SETTINGS.importBrowser.id}
          title={SETTINGS.importBrowser.title}
          description="Bookmarks, history, passwords, tabs and Arc spaces from Chrome, Arc, Safari, Firefox and more."
        >
          <Button title="Import…" onPress={openImport} />
        </Row>
      </Group>
    </View>
  );
}

function UpdatesSection() {
  const [state, setState] = useState<UpdaterState | null>(null);
  const refresh = () => void updaterState().then(setState, () => setState({ available: false }));
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener("change", refresh);
    return () => sub.remove();
  }, []);
  if (!state?.available) return null;
  const ready = state.configured;
  const set = (patch: { automaticChecks?: boolean; automaticDownloads?: boolean }) => {
    setState({ ...state, ...patch });
    if (patch.automaticChecks !== undefined) void setAutomaticUpdateChecks(patch.automaticChecks).finally(refresh);
    if (patch.automaticDownloads !== undefined) void setAutomaticUpdateDownloads(patch.automaticDownloads).finally(refresh);
  };
  const lastCheck = state.lastCheck
    ? `Last checked ${new Date(state.lastCheck).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`
    : "Not checked yet.";
  return (
    <>
      <SectionHeader
        title="Downloads"
        description={
          tidyNames ? "Apple's on-device model writes the suggested name. Nothing leaves this Mac." : "Bay cleans the name on this Mac. Nothing leaves it."
        }
      />
      <Group>
        <SettingToggle
          setting="tidyDownloads"
          settingId={SETTINGS.tidyDownloads.id}
          title={SETTINGS.tidyDownloads.title}
          description="Offer a readable name for files the web hands over with machine names, like IMG_20261024_8812.pdf. You choose whether to rename each file; files you named yourself are left alone."
        />
      </Group>

      <SectionHeader title="Updates" description={ready ? undefined : "Updates aren't set up for this build."} />
      <Group>
        <Row settingId={SETTINGS.automaticUpdateChecks.id} title={SETTINGS.automaticUpdateChecks.title} description={SHARING_COPY.updateChecks}>
          <Toggle value={ready && state.automaticChecks} disabled={!ready} onChange={(v) => set({ automaticChecks: v })} />
        </Row>
        <Row
          settingId={SETTINGS.automaticUpdateDownloads.id}
          title={SETTINGS.automaticUpdateDownloads.title}
          description="Downloads updates in the background and installs them the next time it restarts."
        >
          <Toggle
            value={ready && state.automaticChecks && state.automaticDownloads}
            disabled={!ready || !state.automaticChecks}
            onChange={(v) => set({ automaticDownloads: v })}
          />
        </Row>
        <Row title={`${APP_NAME} ${state.version}`} description={ready ? lastCheck : undefined}>
          <Button title="Check Now" disabled={ready && (!state.canCheck || state.sessionInProgress)} onPress={() => void checkForUpdates().finally(refresh)} />
        </Row>
      </Group>
    </>
  );
}

function DefaultBrowserBanner() {
  const theme = useTheme();
  const colors = useFormColors();
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  // Why setting the default failed, when trying again can't help (Linux without bay.desktop installed).
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => void isDefaultBrowser().then(setIsDefault);
  const makeDefault = () =>
    void setAsDefaultBrowser().then(
      (value) => {
        setProblem(null);
        setIsDefault(value);
      },
      (failure: unknown) => setProblem(failure instanceof Error ? failure.message : "The default browser wasn't changed. Try again."),
    );
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener("change", refresh);
    return () => sub.remove();
  }, []);
  if (isDefault === null) return <View style={{ height: 20 }} />;
  return (
    <View
      style={{
        marginTop: 20,
        padding: 14,
        borderRadius: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: colors.group,
        borderWidth: 1,
        borderColor: colors.groupBorder,
      }}
    >
      <Symbol name={isDefault ? "checkmark.seal.fill" : "safari"} size={20} color={isDefault ? "#34C759" : theme.icon} style={{ width: 28, height: 28 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, color: theme.textPrimary }}>
          {isDefault ? `${APP_NAME} is your default browser` : `${APP_NAME} works best as your default browser`}
        </Text>
        {!isDefault && problem && <Text style={{ fontSize: 12, color: theme.textSecondary }}>{problem}</Text>}
      </View>
      {!isDefault && <Button title={`Set ${APP_NAME} as Default`} kind="primary" onPress={makeDefault} />}
    </View>
  );
}
