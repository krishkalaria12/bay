import { View } from "@bay/platform";
import { useState } from "react";
import { Text } from "react-native";
import { reportBrowserCommand } from "../../../runtime/commands";
import { updateSettings } from "../../../runtime/settingsActions";
import { useBrowserRead, browserRead } from "../../../store/read";
import { defaultLinkDestination, validateLinkPattern, type ExternalLinkRule, type LinkDestination, type LinkMatchType } from "../../../lib/externalLinkRules";
import { useTheme } from "../../../lib/theme";
import { useSpaces } from "../../../store/hooks";
import { newId } from "../../../store/model";
import { IconButton } from "../../primitives";
import { Button, Group, PopUp, Row, SectionHeader, Sheet, TextField } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

export function showRuleEditor(ruleId?: string) {
  const rule = ruleId === undefined ? undefined : browserRead.getState().settings.externalLinkRules.find((candidate) => candidate.id === ruleId);
  if (ruleId !== undefined && !rule) return;
  showSettingsSheet(<RuleSheet key={rule?.id ?? "new"} rule={rule} />);
}

export function LinkRules() {
  const settings = useBrowserRead((s) => s.settings);
  const spaces = useSpaces();
  const rules = settings.externalLinkRules;
  const defaultDestination = defaultLinkDestination(settings);
  const selectedDefault = defaultDestination.kind === "space" ? `space:${defaultDestination.spaceId}` : defaultDestination.kind;
  const move = (id: string, direction: number) => {
    const state = browserRead.getState();
    const next = [...state.settings.externalLinkRules];
    const from = next.findIndex((rule) => rule.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to]!, next[from]!];
    reportBrowserCommand(updateSettings({ externalLinkRules: next }));
  };
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.externalLinkRules.id}
        title={SETTINGS.externalLinkRules.title}
        description="For links from other apps and Peek's Open as Tab. The first matching rule decides where a link opens."
        action={<Button title="Add…" icon="plus" onPress={() => showRuleEditor()} />}
      />
      <Group>
        <Row
          settingId={SETTINGS.openLinksInLittleBay.id}
          title={SETTINGS.openLinksInLittleBay.title}
          description="Where links from other apps open when no rule matches."
        >
          <PopUp
            value={selectedDefault}
            options={[
              ...spaces.map((space) => ({ value: `space:${space.id}`, title: space.name })),
              { value: "mostRecentSpace", title: "Most Recent Space", separatorBefore: true },
              { value: "littleBay", title: "Little Bay" },
              ...(defaultDestination.kind === "newWindow" ? [{ value: "newWindow", title: "New window" }] : []),
            ]}
            onChange={(value) =>
              reportBrowserCommand(
                updateSettings({
                  externalLinkDefault: value.startsWith("space:")
                    ? { kind: "space", spaceId: value.slice(6) }
                    : { kind: value as "mostRecentSpace" | "littleBay" | "newWindow" },
                }),
              )
            }
            minWidth={180}
          />
        </Row>
        {rules.length === 0 ? (
          <Row title="No link rules" description="Send matching links to a space, Little Bay or a new window." />
        ) : (
          rules.map((rule, index) => {
            const destination = rule.destination;
            const target =
              destination.kind === "space"
                ? (spaces.find((space) => space.id === destination.spaceId)?.name ?? "Missing space. Edit this rule to choose another.")
                : destination.kind === "mostRecentSpace"
                  ? "Most Recent Space"
                  : destination.kind === "littleBay"
                    ? "Little Bay"
                    : "New window";
            const matchLabel = rule.matchType === "contains" ? "Contains" : rule.matchType === "equals" ? "Is equal to" : "Wildcard (existing rule)";
            return (
              <Row key={rule.id} title={`${index + 1}. ${rule.pattern}`} description={`${matchLabel} · ${rule.sourceApp || "Any app"} → ${target}`}>
                <IconButton icon="arrow.up" size={11} box={24} radius={6} disabled={index === 0} tooltip="Move rule up" onPress={() => move(rule.id, -1)} />
                <IconButton
                  icon="arrow.down"
                  size={11}
                  box={24}
                  radius={6}
                  disabled={index === rules.length - 1}
                  tooltip="Move rule down"
                  onPress={() => move(rule.id, 1)}
                />
                <Button title="Edit…" onPress={() => showRuleEditor(rule.id)} />
              </Row>
            );
          })
        )}
      </Group>
    </>
  );
}

export function RuleSheet({ rule }: { rule?: ExternalLinkRule }) {
  const theme = useTheme();
  const spaces = useSpaces();
  const defaultSpaceId = useBrowserRead((s) => s.settings.defaultSpaceId);
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [matchType, setMatchType] = useState<LinkMatchType | undefined>(rule ? rule.matchType : "contains");
  const [sourceApp, setSourceApp] = useState(rule?.sourceApp ?? "");
  const [destination, setDestination] = useState<LinkDestination>(() => rule?.destination ?? { kind: "space", spaceId: defaultSpaceId });
  const [error, setError] = useState<string | null>(null);
  const selected = destination.kind === "space" ? `space:${destination.spaceId}` : destination.kind;
  const missingSpace = destination.kind === "space" && !spaces.some((space) => space.id === destination.spaceId);
  const save = async () => {
    const cleanPattern = pattern.trim();
    const cleanSource = sourceApp.trim();
    const patternError = validateLinkPattern(cleanPattern, matchType);
    if (patternError) return setError(patternError);
    if (cleanSource && !/^[\w.-]+$/.test(cleanSource)) return setError("Enter an app bundle ID without spaces, or leave it blank for any app.");
    const state = browserRead.getState();
    if (destination.kind === "space" && !state.spaces[destination.spaceId]) return setError("Choose an existing space for this rule.");
    const saved: ExternalLinkRule = {
      id: rule?.id ?? newId("link-rule"),
      pattern: cleanPattern,
      ...(matchType ? { matchType } : {}),
      ...(cleanSource ? { sourceApp: cleanSource } : {}),
      destination,
    };
    const rules = state.settings.externalLinkRules;
    const externalLinkRules = rule ? rules.map((existing) => (existing.id === rule.id ? saved : existing)) : [...rules, saved];
    try {
      await updateSettings({ externalLinkRules });
      closeSettingsSheet();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the link rule.");
    }
  };
  const labelStyle = { fontSize: 11.5, marginBottom: 5, color: theme.textSecondary };
  const helpStyle = { fontSize: 11.5, lineHeight: 16, marginTop: 5, color: theme.textSecondary };
  return (
    <Sheet width={460} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{rule ? "Edit Link Rule" : "Add Link Rule"}</Text>
      <View style={{ marginTop: 12 }}>
        <Text style={labelStyle}>When URL</Text>
        <PopUp<LinkMatchType | "wildcard">
          value={matchType ?? "wildcard"}
          options={[
            { value: "contains", title: "Contains" },
            { value: "equals", title: "Is equal to" },
            ...(rule && rule.matchType === undefined ? [{ value: "wildcard" as const, title: "Wildcard (existing rule)" }] : []),
          ]}
          onChange={(value) => setMatchType(value === "wildcard" ? undefined : value)}
          minWidth={240}
        />
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={labelStyle}>{matchType === undefined ? "Site or URL pattern" : "URL or text"}</Text>
        <TextField
          value={pattern}
          onChangeText={setPattern}
          placeholder={
            matchType === "contains"
              ? "example.com/work?view=board"
              : matchType === "equals"
                ? "https://example.com/work?view=board#today"
                : "github.com/acme/*"
          }
          autoFocus
          onSubmit={save}
          onEscape={closeSettingsSheet}
        />
        <Text style={helpStyle}>
          {matchType === "contains"
            ? "Match any part of a URL, including query strings and fragments. Text is matched literally."
            : matchType === "equals"
              ? "Match a full URL exactly, including its query string and fragment."
              : "Use * as a wildcard, such as *.example.com or example.com/work/*. A host alone matches all its paths."}
        </Text>
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={labelStyle}>From app, optional</Text>
        <TextField value={sourceApp} onChangeText={setSourceApp} placeholder="Any app" onSubmit={save} onEscape={closeSettingsSheet} />
        <Text style={helpStyle}>
          Use the app's bundle ID, such as com.tinyspeck.slackmacgap for Slack or com.apple.mail for Mail. Applies when the sending app is known.
        </Text>
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={labelStyle}>Open in</Text>
        <PopUp
          value={selected}
          options={[
            ...spaces.map((space) => ({ value: `space:${space.id}`, title: `Space: ${space.name}` })),
            ...(missingSpace ? [{ value: selected, title: "Missing space. Choose another." }] : []),
            { value: "mostRecentSpace", title: "Most Recent Space", separatorBefore: true },
            { value: "littleBay", title: "Little Bay" },
            { value: "newWindow", title: "New window" },
          ]}
          onChange={(value) =>
            setDestination(
              value.startsWith("space:") ? { kind: "space", spaceId: value.slice(6) } : { kind: value as "mostRecentSpace" | "littleBay" | "newWindow" },
            )
          }
          minWidth={240}
        />
      </View>
      {error && <Text style={{ fontSize: 12, marginTop: 10, color: "#FF453A" }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        {rule && (
          <Button
            title="Delete"
            kind="destructive"
            onPress={async () => {
              const state = browserRead.getState();
              try {
                await updateSettings({ externalLinkRules: state.settings.externalLinkRules.filter((existing) => existing.id !== rule.id) });
                closeSettingsSheet();
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : "Couldn't delete the link rule.");
              }
            }}
          />
        )}
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={rule ? "Save" : "Add"} kind="primary" onPress={save} />
      </View>
    </Sheet>
  );
}
