import {
  deletePassword,
  getPassword,
  getPasswordAutofill,
  hasWebKit,
  secretStorage,
  setNeverSavePasswords,
  setPasswordAutofill,
  updatePassword,
  type SavedPassword,
  type SecretStorageKind,
} from "@bay/chromium";
import { confirm, copyText, openFile, Symbol, systemInfo } from "@bay/desktop";
import { useEffect, useState } from "react";
import { platformOS, View } from "@bay/platform";
import { Text } from "react-native";
import { useTheme } from "../../../lib/theme";
import { useBrowserRead as useBrowser } from "../../../store/read";
import { useSpaces } from "../../../store/hooks";
import { engineProfile, plural } from "../../../store/model";
import { hostLabel, matchesQuery } from "../../pages/PageLayout";
import { Favicon, IconButton } from "../../ui/primitives";
import { Button, Group, PopUp, Row, SearchField, SectionHeader, Sheet, TextField } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";
import { MONO_FONT } from "../../../lib/constants";
import { usePasswordsUnlocked, withWorkflows } from "../settingsCommands";
import { passwordStorageDescription, secretStorageWarning } from "../secretStorage";
import { platformWords } from "../../../lib/platformWords";
import { PasskeysRow } from "../PasskeysRow";

const PASSWORDS_APP = "/System/Applications/Passwords.app";

/** Spaces that share a space's website data share its password manager. */
function sharedNote(names: string[]): string | null {
  if (!names.length) return null;
  const others = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;

  return `Also applies to ${others}, which ${names.length === 1 ? "shares" : "share"} this space's website data.`;
}

// 1Password connects to a browser it has been told to trust, and only to one installed in Applications.
function passwordManagerAppsNote() {
  const apps = `1Password, Bitwarden, KeePassXC and Proton Pass extensions connect to their ${platformWords.desktopApps}.`;

  return systemInfo().inApplicationsFolder === false
    ? `${apps} For 1Password, move Bay to your Applications folder and reopen it (1Password only connects to browsers there), then in the 1Password app open Settings › Browser › Add Browser and choose it.`
    : `${apps} For 1Password, add Bay once: in the 1Password app, open Settings › Browser › Add Browser and choose Bay.`;
}

export function PasswordsPane({ spaceId: initial }: { spaceId?: string | null }) {
  const theme = useTheme();
  const profiles = useSpaces();
  const [spaceId, setSpaceId] = useState(() => initial ?? useBrowser.getState().settings.defaultSpaceId);
  const [list, setList] = useState<SavedPassword[] | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [autofill, setAutofill] = useState(true);
  const [query, setQuery] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [storage, setStorage] = useState<SecretStorageKind | null>(null);
  const profile = engineProfile(spaceId);
  const unlocked = usePasswordsUnlocked(profile);

  // The profile's list: an answer for a profile the pane has since left is dropped.
  const load = (live: () => boolean = () => true) => {
    void withWorkflows((w) => w.passwords(profile)).then((answer) => {
      if (!answer || !live()) return;
      setList(answer.passwords);
      setNever(answer.never);
    });
  };

  useEffect(() => {
    setList(null);
    setNever([]);

    if (!unlocked) return;
    let current = true;
    load(() => current);

    return () => void (current = false);
  }, [unlocked, spaceId]);
  useEffect(() => {
    let current = true;

    void getPasswordAutofill(profile)
      .then((on) => current && setAutofill(on))
      .catch(() => {});

    return () => void (current = false);
  }, [profile]);

  // Linux can fall back to a fixed key when no keyring answers: the pane says so.
  useEffect(() => {
    let current = true;

    void secretStorage()
      .then((kind) => current && setStorage(kind))
      .catch(() => {});

    return () => void (current = false);
  }, []);
  const storageWarning = secretStorageWarning(storage);

  const unlock = () => void withWorkflows((w) => w.unlock(profile));

  const importCsv = async () => {
    const outcome = await withWorkflows((w) => w.importCsv(profile));

    if (outcome.kind === "unavailable") return setImportStatus("Importing isn't available in this build.");

    if (outcome.kind === "cancelled") return;

    if (outcome.kind === "failed") return setImportStatus(`Couldn't import that file: ${outcome.reason}`);
    setImportStatus(`Imported ${plural(outcome.saved, "password")}.`);
    load();
  };

  const exportCsv = async () => {
    const { status, path } = await withWorkflows((w) => w.exportCsv(profile));
    const folder = path ? path.split(/[\\/]/).slice(-2, -1)[0] : "";

    if (status === "succeeded") setExportStatus(`Saved to “${folder}”. Delete the file once you're done with it.`);
    else if (status === "writeFailed") setExportStatus("Couldn't write the file. Try another folder.");
    else if (status === "inProgress") setExportStatus("An export is already running.");
    else setExportStatus("");
  };

  // The Mac's Passwords app (iCloud Keychain) imports Chrome's CSV: File › Import Passwords.
  const exportToPasswords = async () => {
    const { status, path } = await withWorkflows((w) => w.exportCsv(profile));

    if (status !== "succeeded" || !path) return setExportStatus(status === "writeFailed" ? "Couldn't write the file. Try another folder." : "");
    const opened = await openFile(PASSWORDS_APP).catch(() => false);
    setExportStatus(
      opened
        ? "In Passwords, choose File › Import Passwords and pick the file Bay saved, then delete the file."
        : "Saved. Import it in Safari › Settings › Passwords › ⋯ › Import Passwords, then delete the file.",
    );
  };

  const shown = (list ?? []).filter((p) => matchesQuery(query, p.origin, p.username));

  return (
    <View>
      <SectionHeader
        title="Passwords"
        description={passwordStorageDescription(platformOS)}
        action={
          profiles.length > 1 ? <PopUp value={spaceId} options={profiles.map((p) => ({ value: p.id, title: p.name }))} onChange={setSpaceId} /> : undefined
        }
      />
      <Group>
        {storageWarning ? (
          <Row
            icon={<Symbol name="exclamationmark.triangle.fill" size={14} color="#FF9500" style={{ width: 28, height: 20 }} />}
            title={storageWarning.title}
            description={storageWarning.description}
          />
        ) : null}
        <Row
          settingId={SETTINGS.passwordManager.id}
          title={SETTINGS.passwordManager.title}
          description={[
            autofill
              ? "Bay offers to save a login after you sign in, and suggests saved ones when you click a login field."
              : "Bay doesn't offer to save or fill logins here, so your password manager extension's own prompts are the only ones.",
            sharedNote(profiles.filter((p) => p.id !== spaceId && engineProfile(p.id) === profile).map((p) => p.name)),
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <PopUp
            value={autofill ? "bay" : "none"}
            options={[
              { value: "bay", title: "Bay" },
              { value: "none", title: "None (an extension handles logins)", separatorBefore: true },
            ]}
            onChange={(manager) => void setPasswordAutofill(manager === "bay", profile).then(() => setAutofill(manager === "bay"))}
            minWidth={230}
          />
        </Row>
        <Row
          settingId={SETTINGS.importPasswords.id}
          title={SETTINGS.importPasswords.title}
          description={importStatus || "From a CSV exported by Chrome, Safari, Firefox, 1Password, Bitwarden…"}
        >
          <Button title="Import CSV…" onPress={() => void importCsv()} />
        </Row>
        <Row
          settingId={SETTINGS.exportPasswords.id}
          title={SETTINGS.exportPasswords.title}
          description={exportStatus || "To a CSV file. Anyone who can open the file can read your passwords."}
        >
          <Button title="Export CSV…" onPress={() => void exportCsv()} />
          {hasWebKit() && <Button title="Export to Passwords…" onPress={() => void exportToPasswords()} />}
        </Row>
        {hasWebKit() && <PasskeysRow />}
        <Row settingId={SETTINGS.passwordManagerApps.id} title={SETTINGS.passwordManagerApps.title} description={passwordManagerAppsNote()} />
      </Group>

      {!unlocked ? (
        <View style={{ alignItems: "center", gap: 10, marginTop: 40 }}>
          <Symbol name="lock.fill" size={26} color={theme.textTertiary} style={{ width: 36, height: 36 }} />
          <Text style={{ fontSize: 14, fontWeight: "500", color: theme.textPrimary }}>Passwords are locked</Text>
          <Text style={{ fontSize: 12, color: theme.textSecondary }}>Unlock with {platformWords.unlockMethod} to see them.</Text>
          <Button title="Unlock" kind="primary" onPress={unlock} style={{ marginTop: 6 }} />
        </View>
      ) : (
        <>
          <SectionHeader
            title={list ? plural(list.length, "Saved Password") : "Saved Passwords"}
            action={<SearchField value={query} onChangeText={setQuery} placeholder="Search" width={200} />}
          />
          <Group>
            {list && shown.length === 0 ? (
              <Row title={query ? "No passwords match" : "No saved passwords"} />
            ) : (
              shown.map((p) => (
                <Row
                  key={`${p.origin}|${p.username}`}
                  icon={<Favicon url={p.origin} />}
                  title={hostLabel(p.origin)}
                  description={p.username || "(no username)"}
                  onPress={() => showSettingsSheet(<PasswordSheet profile={profile} saved={p} onChanged={() => load()} />)}
                />
              ))
            )}
          </Group>
          {never.length > 0 && (
            <>
              <SectionHeader title="Never saved" description="Sites where you chose “Never on This Site”." />
              <Group>
                {never.map((origin) => (
                  <Row key={origin} icon={<Favicon url={origin} />} title={hostLabel(origin)}>
                    <Button title="Remove" onPress={() => void setNeverSavePasswords(profile, origin, false).then(() => load())} />
                  </Row>
                ))}
              </Group>
            </>
          )}
        </>
      )}
    </View>
  );
}

function PasswordSheet({ profile, saved, onChanged }: { profile: string; saved: SavedPassword; onChanged: () => void }) {
  const theme = useTheme();
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => void getPassword(profile, saved.origin, saved.username).then(setPassword), []);

  const save = async () => {
    await updatePassword(profile, saved.origin, saved.username, {
      username: username !== saved.username ? username : undefined,
      password: password ?? undefined,
    });
    onChanged();
    closeSettingsSheet();
  };

  const remove = async () => {
    const { confirmed } = await confirm({
      title: `Delete the password for ${hostLabel(saved.origin)}?`,
      message: "You won't be able to sign in with it automatically any more.",
      confirmTitle: "Delete",
      destructive: true,
    });

    if (!confirmed) return;
    await deletePassword(profile, saved.origin, saved.username);
    onChanged();
    closeSettingsSheet();
  };

  return (
    <Sheet width={440} onClose={closeSettingsSheet}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Favicon url={saved.origin} size={22} />
        <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{hostLabel(saved.origin)}</Text>
      </View>
      <View style={{ marginTop: 14 }}>
        <Group>
          <Row title="Website" description={saved.origin} />
          <Row title="Username">
            {editing ? (
              <TextField value={username} onChangeText={setUsername} style={{ width: 220 }} />
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text selectable style={{ fontSize: 13, color: theme.textPrimary }}>
                  {saved.username}
                </Text>
                <IconButton icon="doc.on.doc" size={11} box={24} radius={6} onPress={() => copyText(saved.username)} tooltip="Copy Username" />
              </View>
            )}
          </Row>
          <Row title="Password">
            {editing ? (
              <TextField value={password ?? ""} onChangeText={setPassword} secure={!revealed} style={{ width: 220 }} />
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text selectable style={{ fontSize: 13, color: theme.textPrimary, fontFamily: revealed ? MONO_FONT : undefined }}>
                  {password === null ? "…" : revealed ? password : "•".repeat(Math.min(password.length, 12))}
                </Text>
                <IconButton
                  icon={revealed ? "eye.slash" : "eye"}
                  size={11}
                  box={24}
                  radius={6}
                  onPress={() => setRevealed(!revealed)}
                  tooltip={revealed ? "Hide" : "Show"}
                />
                <IconButton icon="doc.on.doc" size={11} box={24} radius={6} onPress={() => password && copyText(password)} tooltip="Copy Password" />
              </View>
            )}
          </Row>
        </Group>
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        <Button title="Delete" kind="destructive" onPress={() => void remove()} />
        <View style={{ flex: 1 }} />
        {editing ? (
          <>
            <Button title="Cancel" onPress={() => setEditing(false)} />
            <Button title="Save" kind="primary" disabled={!password} onPress={() => void save()} />
          </>
        ) : (
          <>
            <Button title="Edit" onPress={() => setEditing(true)} />
            <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
          </>
        )}
      </View>
    </Sheet>
  );
}
