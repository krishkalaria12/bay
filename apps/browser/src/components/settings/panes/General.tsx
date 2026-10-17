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
  updaterState,
  type UpdaterState,
} from "@bay/shell";
import { useEffect, useState } from "react";
import { AppState, Text } from "react-native";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import { SHARING_COPY } from "../../../telemetry/copy";
import { Button, Group, PopUp, Row, SectionHeader, Toggle, useFormColors } from "../controls";
import { openImport } from "../windows";
import { APP_NAME } from "../../../lib/constants";

export function GeneralPane() {
  const settings = useBrowser((s) => s.settings);
  const update = useBrowser((s) => s.updateSettings);
  const [loginStatus, setLoginStatus] = useState<string>("notRegistered");

  const refreshLogin = () => void launchAtLoginStatus().then(setLoginStatus);
  useEffect(refreshLogin, []);

  return (
    <View>
      <DefaultBrowserBanner />

      <SectionHeader title="General" />
      <Group>
        <Row
          title={`Open ${APP_NAME} at login`}
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
        <Row title="Warn before quitting" description={isMac ? `Asks before ${APP_NAME} quits with ⌘Q.` : `Asks before ${APP_NAME} quits.`}>
          <Toggle value={settings.warnBeforeQuitting} onChange={(v) => update({ warnBeforeQuitting: v })} />
        </Row>
        <Row title="Warn before closing a window with multiple tabs" description={shortcutLabel("Asks before ⇧⌘W or the close button closes its tabs.")}>
          <Toggle value={settings.warnBeforeClosingWindow} onChange={(v) => update({ warnBeforeClosingWindow: v })} />
        </Row>
      </Group>

      <SectionHeader title={`When opening ${APP_NAME}:`} />
      <Group>
        <Row title="Start on" description="Your tabs stay in the sidebar either way.">
          <PopUp
            value={settings.launchTab}
            options={[
              { value: "newTab", title: "A new tab" },
              { value: "lastTab", title: "The last tab you viewed" },
            ]}
            onChange={(v) => update({ launchTab: v })}
            minWidth={190}
          />
        </Row>
      </Group>

      <SectionHeader title={`When quitting ${APP_NAME}:`} />
      <Group>
        <Row title="Windows and tabs" description="What you see the next time you open it. Closed windows stay in History › Recently Closed.">
          <PopUp
            value={settings.restoreSession ? "keep" : "close"}
            options={[
              { value: "keep", title: "Preserve tabs and windows" },
              { value: "close", title: "Start fresh" },
            ]}
            onChange={(v) => update({ restoreSession: v === "keep" })}
            minWidth={190}
          />
        </Row>
      </Group>

      <SectionHeader title="Command bar" description="What happens when what you type could be a website or a search." />
      <Group>
        <Row title="When input looks like a website">
          <PopUp
            value={settings.commandBarPreference}
            options={[
              { value: "website", title: "Use Website First" },
              { value: "search", title: "Prefer Search Engine" },
            ]}
            onChange={(v) => update({ commandBarPreference: v })}
            minWidth={190}
          />
        </Row>
      </Group>

      <UpdatesSection />

      <SectionHeader title="Import" />
      <Group>
        <Row title="Import from another browser" description="Bookmarks, history, passwords, tabs and Arc spaces from Chrome, Arc, Safari, Firefox and more.">
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
      <SectionHeader title="Updates" description={ready ? undefined : "Updates aren't set up for this build."} />
      <Group>
        <Row title="Check for updates automatically" description={SHARING_COPY.updateChecks}>
          <Toggle value={ready && state.automaticChecks} disabled={!ready} onChange={(v) => set({ automaticChecks: v })} />
        </Row>
        <Row title={`Automatically update ${APP_NAME}`} description="Downloads updates in the background and installs them the next time it restarts.">
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
  const refresh = () => void isDefaultBrowser().then(setIsDefault);
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
      <Text style={{ flex: 1, fontSize: 13, color: theme.textPrimary }}>
        {isDefault ? `${APP_NAME} is your default browser` : `${APP_NAME} works best as your default browser`}
      </Text>
      {!isDefault && <Button title={`Set ${APP_NAME} as Default`} kind="primary" onPress={() => void setAsDefaultBrowser().then(setIsDefault)} />}
    </View>
  );
}
