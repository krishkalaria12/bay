import { useState } from "react";
import { Text, View } from "react-native";
import { validateLinkPattern, type ExternalLinkRule, type LinkDestination } from "../../../lib/externalLinkRules";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import { useSpaces } from "../../../store/hooks";
import { newId } from "../../../store/model";
import { IconButton } from "../../primitives";
import { Button, Group, PopUp, Row, SectionHeader, Sheet, TextField } from "../controls";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

export function showRuleEditor(ruleId?: string) {
  const rule = ruleId === undefined ? undefined : useBrowser.getState().settings.externalLinkRules.find((candidate) => candidate.id === ruleId);
  if (ruleId !== undefined && !rule) return;
  showSettingsSheet(<RuleSheet key={rule?.id ?? "new"} rule={rule} />);
}

export function LinkRules() {
  const rules = useBrowser((s) => s.settings.externalLinkRules);
  const spaces = useBrowser((s) => s.spaces);
  const move = (id: string, direction: number) => {
    const state = useBrowser.getState();
    const next = [...state.settings.externalLinkRules];
    const from = next.findIndex((rule) => rule.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to]!, next[from]!];
    state.updateSettings({ externalLinkRules: next });
  };
  return (
    <>
      <SectionHeader
        title="Rules for links from other apps"
        description="The first matching rule decides where a link opens. Other links use your choice above."
        action={<Button title="Add…" icon="plus" onPress={() => showRuleEditor()} />}
      />
      <Group>
        {rules.length === 0 ? (
          <Row title="No link rules" description="Send matching sites or paths to a space, Little Bay or a new window." />
        ) : (
          rules.map((rule, index) => {
            const destination = rule.destination;
            const target =
              destination.kind === "space"
                ? (spaces[destination.spaceId]?.name ?? "Missing space. Edit this rule to choose another.")
                : destination.kind === "littleBay"
                  ? "Little Bay"
                  : "New window";
            return (
              <Row key={rule.id} title={`${index + 1}. ${rule.pattern}`} description={`${rule.sourceApp || "Any app"} → ${target}`}>
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
  const defaultSpaceId = useBrowser((s) => s.settings.defaultSpaceId);
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [sourceApp, setSourceApp] = useState(rule?.sourceApp ?? "");
  const [destination, setDestination] = useState<LinkDestination>(() => rule?.destination ?? { kind: "space", spaceId: defaultSpaceId });
  const [error, setError] = useState<string | null>(null);
  const selected = destination.kind === "space" ? `space:${destination.spaceId}` : destination.kind;
  const missingSpace = destination.kind === "space" && !spaces.some((space) => space.id === destination.spaceId);
  const save = () => {
    const cleanPattern = pattern.trim();
    const cleanSource = sourceApp.trim();
    const patternError = validateLinkPattern(cleanPattern);
    if (patternError) return setError(patternError);
    if (cleanSource && !/^[\w.-]+$/.test(cleanSource)) return setError("Enter an app bundle ID without spaces, or leave it blank for any app.");
    const state = useBrowser.getState();
    if (destination.kind === "space" && !state.spaces[destination.spaceId]) return setError("Choose an existing space for this rule.");
    const saved: ExternalLinkRule = {
      id: rule?.id ?? newId("link-rule"),
      pattern: cleanPattern,
      ...(cleanSource ? { sourceApp: cleanSource } : {}),
      destination,
    };
    const rules = state.settings.externalLinkRules;
    state.updateSettings({ externalLinkRules: rule ? rules.map((existing) => (existing.id === rule.id ? saved : existing)) : [...rules, saved] });
    closeSettingsSheet();
  };
  const labelStyle = { fontSize: 11.5, marginBottom: 5, color: theme.textSecondary };
  const helpStyle = { fontSize: 11.5, lineHeight: 16, marginTop: 5, color: theme.textSecondary };
  return (
    <Sheet width={460} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{rule ? "Edit Link Rule" : "Add Link Rule"}</Text>
      <View style={{ marginTop: 12 }}>
        <Text style={labelStyle}>Site or URL pattern</Text>
        <TextField value={pattern} onChangeText={setPattern} placeholder="github.com/acme/*" autoFocus onSubmit={save} onEscape={closeSettingsSheet} />
        <Text style={helpStyle}>Use * as a wildcard, such as *.example.com or example.com/work/*. A host alone matches all its paths.</Text>
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
            { value: "littleBay", title: "Little Bay", separatorBefore: true },
            { value: "newWindow", title: "New window" },
          ]}
          onChange={(value) =>
            setDestination(value.startsWith("space:") ? { kind: "space", spaceId: value.slice(6) } : { kind: value as "littleBay" | "newWindow" })
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
            onPress={() => {
              const state = useBrowser.getState();
              state.updateSettings({ externalLinkRules: state.settings.externalLinkRules.filter((existing) => existing.id !== rule.id) });
              closeSettingsSheet();
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
