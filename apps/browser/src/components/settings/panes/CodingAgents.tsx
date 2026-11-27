import { View } from "@bay/platform";
import { answerCliAgent, type CliAgent } from "@bay/chromium";
import { useState } from "react";
import { Text } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { useTheme } from "../../../lib/theme";
import { isIncognitoSpace } from "../../../store/model";
import { useBrowserRead } from "../../../store/read";
import { agentSpaces, removeAgent, setAgentSpaces, useCliAgents } from "../../cli/agentApprovals";
import { Button, Checkbox, Group, Row, Sheet } from "../controls";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

// Settings › Advanced › Coding agents: the agents with their own access (components/cli/agentApprovals.ts), where
// they reach, and the ones still waiting for an answer.

const useSpaces = () =>
  useBrowserRead(useShallow((s) => s.spaceOrder.flatMap((id) => (s.spaces[id] && !isIncognitoSpace(id) ? [{ id, name: s.spaces[id]!.name }] : []))));

export function CodingAgents() {
  const { agents, requests } = useCliAgents();
  const spaces = useSpaces();

  if (!agents.length && !requests.length) return null;

  const reach = (agent: CliAgent) => {
    const ids = agentSpaces(
      agent,
      spaces.map((s) => s.id),
    );

    if (ids === null) return "Every space, never private windows";

    return ids.length ? spaces.flatMap((s) => (ids.includes(s.id) ? [s.name] : [])).join(", ") : "No spaces";
  };

  return (
    <Group>
      {requests.map((r) => (
        <Row key={`request:${r.agent}`} title={r.name} description="Asked to use Bay and is waiting for your answer.">
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button title="Don't Allow" onPress={() => void answerCliAgent(r.agent, false)} />
            <Button title="Allow…" kind="primary" onPress={() => showSettingsSheet(<SpacesSheet agent={r.agent} name={r.name} chosen={[]} />)} />
          </View>
        </Row>
      ))}
      {agents.map((a) => (
        <Row key={a.id} title={a.name} description={reach(a)}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button
              title="Spaces…"
              onPress={() =>
                showSettingsSheet(
                  <SpacesSheet
                    agent={a.id}
                    name={a.name}
                    chosen={agentSpaces(
                      a,
                      spaces.map((s) => s.id),
                    )}
                  />,
                )
              }
            />
            <Button title="Remove" kind="destructive" onPress={() => void removeAgent(a.id)} />
          </View>
        </Row>
      ))}
    </Group>
  );
}

/** Which spaces an agent reaches: every one (with spaces made later), or the ones ticked. */
function SpacesSheet({ agent, name, chosen }: { agent: string; name: string; chosen: string[] | null }) {
  const theme = useTheme();
  const spaces = useSpaces();
  const [every, setEvery] = useState(chosen === null);
  const [ticked, setTicked] = useState<string[]>(chosen ?? []);

  const save = () => {
    void setAgentSpaces(agent, every ? null : ticked);
    closeSettingsSheet();
  };

  return (
    <Sheet width={420} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>Spaces {name} Can Use</Text>
      <Text style={{ fontSize: 12, marginTop: 4, marginBottom: 12, lineHeight: 16, color: theme.textSecondary }}>
        It can open, read and use web pages in these spaces. Private windows are never reachable.
      </Text>
      <Checkbox value={every} onChange={setEvery} label="Every space, including new ones" />
      {spaces.map((s) => (
        <View key={s.id} style={{ marginTop: 6, marginLeft: 18 }}>
          <Checkbox
            value={every || ticked.includes(s.id)}
            disabled={every}
            onChange={(on) => setTicked((t) => (on ? [...t, s.id] : t.filter((id) => id !== s.id)))}
            label={s.name}
          />
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Allow" kind="primary" disabled={!every && !ticked.length} onPress={save} />
      </View>
    </Sheet>
  );
}
