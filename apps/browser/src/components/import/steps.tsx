import { View } from "@bay/platform";
import type { DiaTabsResult, ImportKind } from "@bay/import";
import { ActivityIndicator, Image, Text } from "react-native";
import { APP_NAME } from "../../lib/constants";
import { useTheme } from "../../lib/theme";
import { plural } from "../../store/model";
import { Button, Checkbox } from "../settings/controls";
import { DIA_NOT_SHARED, KINDS } from "./constants";
import type { ImportFlow } from "./useImportFlow";
import {
  BrowserRow,
  CategoryRow,
  ErrorText,
  FileDrop,
  FullDiskAccessSteps,
  Handoff,
  Monogram,
  Note,
  SelectRow,
  SettingsSteps,
  Spacer,
  SpaceIcon,
  StepLayout,
  SuccessMark,
  TargetPicker,
  Title,
} from "./ui";

type StepProps = { flow: ImportFlow };

const kindTitle = (k: ImportKind) => KINDS.find((x) => x.kind === k)?.title ?? k;

function diaProfileSummary(dia: DiaTabsResult | null, id: string): string | undefined {
  const p = dia?.profiles.find((x) => x.id === id);
  return p ? `${plural(p.pinned.length, "pinned tab")} · ${plural(p.tabs.length, "open tab")}` : undefined;
}

// A step whose source has gone: the window's frame, nothing in it.
function EmptyStep() {
  return <StepLayout footer={null}>{null}</StepLayout>;
}

export function LoadingStep() {
  return (
    <StepLayout footer={null}>
      <ActivityIndicator style={{ marginTop: 80 }} />
    </StepLayout>
  );
}

export function ChooseStep({ flow }: StepProps) {
  const theme = useTheme();
  const { source, isArc, isDiaTabs } = flow;
  const offered = isDiaTabs
    ? KINDS.filter((k) => k.kind === "tabs" || k.kind === "pinnedTabs")
    : KINDS.filter((k) => source?.profiles.some((p) => p.available.includes(k.kind)) && !["spaces", "pinnedTabs"].includes(k.kind));
  return (
    <StepLayout
      footer={
        <>
          {flow.available ? <Button title="Bookmarks HTML File…" onPress={() => void flow.importHtml()} /> : null}
          <Spacer />
          <TargetPicker value={flow.target} onChange={flow.setTarget} />
          <Button title="Cancel" onPress={flow.close} />
          <Button
            title="Continue"
            kind="primary"
            disabled={!source || (!source.requiresExport && !source.needsFullDiskAccess && flow.kinds.size === 0)}
            onPress={flow.next}
          />
        </>
      }
    >
      <Title
        title="Import from Another Browser"
        subtitle="Import once and stay in your flow. Your tabs, passwords, bookmarks and history come with you, and you stay signed in."
      />
      {!flow.available ? (
        <Note text={`Importing isn't available in this build of ${APP_NAME}.`} />
      ) : flow.browsers.length === 0 ? (
        <Note text="No other browsers with data to import were found on this Mac." />
      ) : (
        <View style={{ gap: 6 }}>
          {flow.browsers.map((b) => (
            <BrowserRow key={b.id} browser={b} selected={source?.id === b.id} onPress={() => flow.choose(b)} />
          ))}
        </View>
      )}
      {source && !source.requiresExport && !source.needsFullDiskAccess && (
        <View style={{ marginTop: 18 }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textSecondary, marginBottom: 8 }}>What to import</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
            {offered.map((k) => (
              <Checkbox
                key={k.kind}
                label={k.kind === "tabs" && isArc ? "Spaces and tabs" : k.kind === "tabs" && isDiaTabs ? "Open tabs" : k.title}
                value={flow.kinds.has(k.kind)}
                onChange={(on) => flow.toggleKind(k.kind, on)}
              />
            ))}
          </View>
          {flow.kinds.has("extensions") && (source.family === "chromium" || source.family === "arc" || source.family === "firefox") && (
            <Text style={{ fontSize: 12, lineHeight: 17, color: theme.textSecondary, marginTop: 10 }}>
              {source.family === "firefox"
                ? `Compatible add-ons and verified Chromium versions will be imported. Unsupported add-ons are listed in the results. Add-on settings stay in ${source.name}.`
                : `Quit ${source.name} before continuing to bring over your extension settings.`}
            </Text>
          )}
          {isDiaTabs && (
            <Text style={{ fontSize: 12, lineHeight: 17, color: theme.textSecondary, marginTop: 10 }}>
              {`${APP_NAME} asks Dia for each profile's open and pinned tabs while Dia is running. ${DIA_NOT_SHARED}`}
            </Text>
          )}
        </View>
      )}
      {flow.error && <ErrorText text={flow.error} />}
    </StepLayout>
  );
}

export function SpacesStep({ flow }: StepProps) {
  const theme = useTheme();
  const { source, isArc, isDiaTabs } = flow;
  if (!source) return <EmptyStep />;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <StepLayout
      footer={
        <>
          <Button title="Back" onPress={() => flow.setStep("choose")} />
          <Spacer />
          <TargetPicker value={flow.target} onChange={flow.setTarget} />
          <Button title="Continue" kind="primary" disabled={isArc ? !flow.spaces.length : !flow.sourceProfiles.length} onPress={flow.next} />
        </>
      }
    >
      {isArc ? (
        <>
          <Title title="Select spaces to import" subtitle={`We'll import your Arc spaces, tabs, and folders to ${APP_NAME}.`} />
          <Text
            style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}
          >{`Customize which spaces to bring over to ${APP_NAME}. Each space becomes a space in ${APP_NAME}.`}</Text>
          <View style={{ gap: 6 }}>
            {flow.allSpaces.map((s) => (
              <SelectRow
                key={s.id}
                selected={flow.spaces.includes(s.id)}
                onToggle={(on) => flow.setSpaces((prev) => toggle(prev, s.id, on))}
                icon={<SpaceIcon space={s} />}
                title={s.name || "Space"}
                subtitle={`${plural(s.pinnedCount, "pinned tab")} · ${plural(s.tabCount, "tab")}`}
              />
            ))}
          </View>
        </>
      ) : (
        <>
          {isDiaTabs ? (
            <Title title="Choose Dia profiles" subtitle="Select the profiles whose tabs you want to bring over." />
          ) : (
            <Title title="Unlock your data for import" subtitle="Select the profiles you want to import." />
          )}
          <Text
            style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}
          >{`Customize which profiles to bring over to ${APP_NAME}. The first goes into your selected space; the others become new spaces.`}</Text>
          <View style={{ gap: 6 }}>
            {source.profiles.map((p) => (
              <SelectRow
                key={p.id}
                selected={flow.sourceProfiles.includes(p.id)}
                onToggle={(on) => flow.setSourceProfiles((prev) => toggle(prev, p.id, on))}
                icon={
                  p.avatarPath ? (
                    <Image source={{ uri: `file://${p.avatarPath}` }} style={{ width: 28, height: 28, borderRadius: 14 }} />
                  ) : (
                    <Monogram name={p.name} color={p.color} />
                  )
                }
                title={p.name}
                subtitle={isDiaTabs ? diaProfileSummary(flow.dia, p.id) : (p.email ?? (p.isDefault ? "Default profile" : undefined))}
              />
            ))}
          </View>
        </>
      )}
    </StepLayout>
  );
}

export function UnlockStep({ flow }: StepProps) {
  const theme = useTheme();
  const { source } = flow;
  if (!source) return <EmptyStep />;
  const many = flow.sourceProfiles.length > 1;
  return (
    <StepLayout
      footer={
        <>
          <Button title="Back" onPress={() => flow.setStep(source.profiles.length > 1 || flow.isArc ? "profiles" : "choose")} />
          <Spacer />
          <Button title="Skip Encrypted Data" onPress={flow.skipEncrypted} />
          <Button title={flow.unlocking ? "Waiting for password..." : "Continue"} kind="primary" disabled={flow.unlocking} onPress={() => void flow.unlock()} />
        </>
      }
    >
      <Title
        title="Unlock your data for import"
        subtitle={`${APP_NAME} can securely import logins, cookies and cards from your previous browser, so you stay signed in and don't have to enter your passwords again.`}
      />
      <View style={{ alignItems: "center", marginTop: 10, gap: 14 }}>
        <Handoff iconPath={source.iconPath} symbol="lock.fill" />
        <Text style={{ fontSize: 13, lineHeight: 18, textAlign: "center", color: theme.textPrimary, maxWidth: 420 }}>
          {many
            ? `Some data is encrypted, so macOS will ask for your computer password once for each selected profile.`
            : `Some data is encrypted, so macOS will ask for your computer password to bring it securely into ${APP_NAME}.`}
        </Text>
        <Text style={{ fontSize: 12, lineHeight: 17, textAlign: "center", color: theme.textSecondary, maxWidth: 420 }}>
          {`macOS may ask whether ${APP_NAME} can use “${source.name} Safe Storage” from your keychain: it's the key ${source.name} encrypts passwords, cookies and cards with. Click Allow. Your data stays on this Mac.`}
        </Text>
      </View>
      {flow.error && <ErrorText text={flow.error} />}
    </StepLayout>
  );
}

export function SafariStep({ flow }: StepProps) {
  const theme = useTheme();
  const importExport = (path: string) => void flow.importSafari(path);
  return (
    <StepLayout
      footer={
        <>
          <Button title="Back" onPress={() => flow.setStep("choose")} />
          <Spacer />
          <TargetPicker value={flow.target} onChange={flow.setTarget} />
          <Button title="Cancel" onPress={flow.close} />
        </>
      }
    >
      {flow.fullDiskAccess ? (
        <>
          <Title
            title="Import from Safari"
            subtitle={`${APP_NAME} can read Safari directly. Bring your bookmarks, history, Reading List, open tabs and sign-ins into ${APP_NAME}.`}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 }}>
            {flow.source?.iconPath ? <Image source={{ uri: `file://${flow.source.iconPath}` }} style={{ width: 40, height: 40 }} /> : null}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>Bookmarks, history, Reading List and tabs</Text>
              <Text style={{ fontSize: 12, color: theme.textSecondary, marginTop: 1 }}>Full Disk Access is granted.</Text>
              <View style={{ marginTop: 8 }}>
                <Checkbox label="Cookies (stay signed in)" value={flow.safariCookies} onChange={flow.setSafariCookies} />
              </View>
            </View>
            <Button title="Import from Safari" kind="primary" onPress={() => void flow.importSafariDirect()} />
          </View>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textSecondary, marginBottom: 8 }}>
            Passwords and payment cards can't be read directly — import them from an export file:
          </Text>
          <FileDrop onFile={importExport} onChoose={flow.chooseSafariExport} />
        </>
      ) : (
        <>
          <Title
            title={`Give ${APP_NAME} access to Safari`}
            subtitle={`To import Safari's bookmarks, history and tabs directly, ${APP_NAME} needs Full Disk Access.`}
          />
          <FullDiskAccessSteps onOpen={flow.openFullDiskAccessSettings} onRecheck={() => void flow.recheckAccess()} />
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textSecondary, marginBottom: 8 }}>
            Or import everything (including passwords) from an export file:
          </Text>
          <View style={{ gap: 6, marginBottom: 12 }}>
            {["Open Safari", "File menu › Export Browsing Data to File", `Upload the .zip file to ${APP_NAME}`].map((t, i) => (
              <Text key={t} style={{ fontSize: 12, color: theme.textSecondary }}>{`${i + 1}. ${t}`}</Text>
            ))}
          </View>
          <FileDrop onFile={importExport} onChoose={flow.chooseSafariExport} />
        </>
      )}
      {flow.error && <ErrorText text={flow.error} />}
    </StepLayout>
  );
}

export function AccessStep({ flow }: StepProps) {
  const { source } = flow;
  if (!source) return <EmptyStep />;
  return (
    <StepLayout
      footer={
        <>
          <Button title="Back" onPress={() => flow.setStep("choose")} />
          <Spacer />
          <Button title="Cancel" onPress={flow.close} />
        </>
      }
    >
      <Title
        title={`Give ${APP_NAME} access to ${source.name}`}
        subtitle={`macOS protects ${source.name}'s data from other apps. To import your bookmarks, history, tabs, passwords and cookies, ${APP_NAME} needs Full Disk Access.`}
      />
      <FullDiskAccessSteps onOpen={flow.openFullDiskAccessSettings} onRecheck={() => void flow.recheckAccess()} />
      {flow.error && <ErrorText text={flow.error} />}
    </StepLayout>
  );
}

export function DiaStep({ flow }: StepProps) {
  const { source, diaStatus } = flow;
  if (!source) return <EmptyStep />;
  return (
    <StepLayout
      footer={
        <>
          <Button title="Back" onPress={() => flow.setStep("choose")} />
          <Spacer />
          <TargetPicker value={flow.target} onChange={flow.setTarget} />
          <Button title="Cancel" onPress={flow.close} />
          {diaStatus === "notDetermined" && (
            <Button title={flow.asking ? "Waiting for macOS..." : "Continue"} kind="primary" disabled={flow.asking} onPress={() => void flow.allowDia()} />
          )}
        </>
      }
    >
      <DiaStatus flow={flow} />
      {flow.error && <ErrorText text={flow.error} />}
    </StepLayout>
  );
}

function DiaStatus({ flow }: StepProps) {
  const theme = useTheme();
  const recheck = () => void flow.refreshDia();
  switch (flow.diaStatus) {
    case "checking":
    case "reading":
      return <Title title="Reading Dia's tabs" subtitle="Asking Dia for its profiles, open tabs and pinned tabs..." spinner />;
    case "notInstalled":
      return <Title title="Dia isn't installed" subtitle={`Install Dia and open it to import its tabs into ${APP_NAME}.`} />;
    case "notRunning":
      return (
        <>
          <Title
            title="Open Dia to import its tabs"
            subtitle={`${APP_NAME} asks Dia for its tabs, so Dia has to be running. Open it and this continues on its own.`}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Button title="Open Dia" kind="primary" onPress={() => void flow.openDia()} />
            <Button title="Check Again" onPress={recheck} />
          </View>
        </>
      );
    case "notDetermined":
      return (
        <>
          <Title
            title={`Allow ${APP_NAME} to read Dia's tabs`}
            subtitle="Dia shares its tabs through AppleScript, and macOS asks you before an app can use it."
          />
          <View style={{ alignItems: "center", marginTop: 10, gap: 14 }}>
            <Handoff iconPath={flow.source?.iconPath} symbol="square.on.square" />
            <Text style={{ fontSize: 13, lineHeight: 18, textAlign: "center", color: theme.textPrimary, maxWidth: 440 }}>
              {`When you continue, macOS asks whether “${APP_NAME}” may control “Dia”. Click Allow, and ${APP_NAME} asks Dia for its profiles, open tabs and pinned tabs. It only reads them: nothing in Dia changes.`}
            </Text>
            <Text style={{ fontSize: 12, lineHeight: 17, textAlign: "center", color: theme.textSecondary, maxWidth: 440 }}>{DIA_NOT_SHARED}</Text>
          </View>
        </>
      );
    case "denied":
      return (
        <>
          <Title
            title={`${APP_NAME} can't read Dia's tabs`}
            subtitle={`macOS doesn't allow ${APP_NAME} to control Dia. You can allow it in System Settings › Privacy & Security › Automation.`}
          />
          <SettingsSteps
            steps={["Click “Open Automation Settings” below", `Under ${APP_NAME}, turn on Dia`, "Come back here: we'll continue automatically"]}
            openTitle="Open Automation Settings"
            onOpen={flow.openAutomationSettings}
            onRecheck={recheck}
          />
        </>
      );
    default:
      return (
        <>
          <Title title="Import tabs from Dia" subtitle={DIA_NOT_SHARED} />
          <Button title="Try Again" onPress={() => void flow.readDia()} />
        </>
      );
  }
}

export function ProgressStep({ flow }: StepProps) {
  const theme = useTheme();
  const { status } = flow;
  return (
    <StepLayout
      footer={
        <>
          <Spacer />
          <Button title="Cancel" onPress={flow.cancel} />
        </>
      }
    >
      <Title
        title={`Importing from ${flow.isDiaTabs ? "Dia" : (flow.source?.name ?? "file")}`}
        subtitle={flow.preparing > 1 ? `Preparing ${flow.preparing} profiles` : "Preparing your profile"}
        spinner
      />
      <Text style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 12 }}>Hold on while we fetch your data...</Text>
      <View style={{ gap: 6 }}>
        {KINDS.filter((k) => status[k.kind]).map((k, i) => (
          <CategoryRow key={k.kind} title={k.title} icon={k.icon} status={status[k.kind]!} index={i} />
        ))}
      </View>
    </StepLayout>
  );
}

export function DoneStep({ flow }: StepProps) {
  const theme = useTheme();
  const { counts, failures, notes, extensions } = flow;
  const failed = failures.length > 0;
  const summary = [
    counts.bookmarks && plural(counts.bookmarks, "bookmark"),
    counts.history && plural(counts.history, "history item"),
    counts.passwords && plural(counts.passwords, "password"),
    counts.cookies && plural(counts.cookies, "cookie"),
    counts.addresses && `${counts.addresses} ${counts.addresses === 1 ? "address" : "addresses"}`,
    counts.cards && plural(counts.cards, "card"),
    counts.tabs && plural(counts.tabs, "tab"),
    counts.extensions && plural(counts.extensions, "extension"),
    counts.extensionSettings && plural(counts.extensionSettings, "extension setting"),
  ].filter(Boolean) as string[];
  const leftBehind = notes.length ? (
    <Text style={{ fontSize: 12, lineHeight: 17, marginTop: 10, color: theme.textTertiary, textAlign: failed ? "left" : "center" }}>{notes.join(" ")}</Text>
  ) : null;
  const extensionList = extensions.length ? (
    <View style={{ alignSelf: "stretch", marginTop: 14, gap: 8 }}>
      <Text style={{ fontSize: 12, color: theme.textSecondary, textAlign: "center" }}>
        {`${plural(extensions.length, "extension")} couldn't be imported. You can try adding them from the Chrome Web Store in their destination spaces:`}
      </Text>
      <Text style={{ fontSize: 12, color: theme.textPrimary, textAlign: "center" }} numberOfLines={3}>
        {extensions.map((e) => e.extension.name).join(", ")}
      </Text>
      <View style={{ alignItems: "center" }}>
        <Button title={extensions.length === 1 ? "Open in Chrome Web Store" : `Open ${extensions.length} in Chrome Web Store`} onPress={flow.openExtensions} />
      </View>
    </View>
  ) : null;
  return (
    <StepLayout
      footer={
        <>
          <Spacer />
          {failed && <Button title="Try Again" onPress={() => flow.setStep("choose")} />}
          <Button title={failed ? "Continue" : "Finish importing"} kind="primary" onPress={flow.close} />
        </>
      }
    >
      {failed ? (
        <>
          <Title title={summary.length ? "Partially imported" : "Import failed"} subtitle="Only some of your data imported. Please try again!" />
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary, marginBottom: 6 }}>Some import steps failed:</Text>
          {failures.map((f) => (
            <Text key={f.kind} style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 3 }}>
              {f.profiles.length ? `${kindTitle(f.kind)} import failed for profiles ${f.profiles.join(", ")}` : `${kindTitle(f.kind)} import failed`}
            </Text>
          ))}
          {summary.length > 0 && <Text style={{ fontSize: 12, marginTop: 12, color: theme.textSecondary }}>{`Imported ${summary.join(", ")}.`}</Text>}
          {leftBehind}
          {extensionList}
          <Text style={{ fontSize: 12, marginTop: 12, color: theme.textTertiary }}>You can retry the import later from the app menu.</Text>
        </>
      ) : (
        <View style={{ alignItems: "center", marginTop: 40, gap: 12 }}>
          <SuccessMark />
          <Text style={{ fontSize: 20, fontWeight: "600", color: theme.textPrimary }}>You're all set</Text>
          <Text style={{ fontSize: 13, color: theme.textSecondary, textAlign: "center" }}>
            {summary.length ? `Imported ${summary.join(", ")}.` : "There was nothing new to import."}
          </Text>
          {leftBehind}
          {extensionList}
        </View>
      )}
    </StepLayout>
  );
}
