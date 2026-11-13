import { Surface } from "@bay/desktop";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { create } from "zustand";
import { hex, useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { spaceFor } from "../../store/model";
import { Button, Checkbox, PopUp } from "../settings/controls";
import { withWorkflows } from "../settings/settingsCommands";

const RANGES = [
  { value: "hour", title: "Last hour", ms: 3_600_000 },
  { value: "day", title: "Last 24 hours", ms: 86_400_000 },
  { value: "week", title: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "month", title: "Last 4 weeks", ms: 28 * 86_400_000 },
  { value: "all", title: "All time", ms: Infinity },
] as const;

type Range = (typeof RANGES)[number]["value"];

export const useClearDataRequest = create<{ windowId: string | null; request(windowId: string | null): void }>((set) => ({
  windowId: null,
  request: (windowId) => set({ windowId }),
}));

export function ClearDataDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const theme = useTheme();
  const spaceName = useBrowser((s) => spaceFor(s, spaceId).name);
  const [range, setRange] = useState<Range>("hour");
  const [history, setHistory] = useState(true);
  const [siteData, setSiteData] = useState(true);
  const [busy, setBusy] = useState(false);

  const [failed, setFailed] = useState(false);

  // The app's history goes at once; the engine's data may not. A clear that could not finish says what it did,
  // and is not tried again on its own.
  const clear = async () => {
    setBusy(true);
    setFailed(false);
    const ms = RANGES.find((r) => r.value === range)!.ms;
    const since = ms === Infinity ? undefined : Date.now() - ms;
    const outcome = await withWorkflows((w) => w.clearData(spaceId, { since, history, siteData }));
    setBusy(false);

    if (outcome.engine === "failed") return setFailed(true);
    onClose();
  };

  return (
    <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.15)" }]} onPress={onClose} />
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={14}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={30}
        shadowOffset={[0, 12]}
        style={{ width: 440, padding: 20 }}
      >
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>Clear Browsing Data</Text>
        <Text style={{ fontSize: 12, marginTop: 4, color: theme.textSecondary }}>{`From your ${spaceName} space`}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 16, gap: 10 }}>
          <Text style={{ fontSize: 13, color: theme.textPrimary }}>Time range</Text>
          <PopUp value={range} options={RANGES.map(({ value, title }) => ({ value, title }))} onChange={setRange} minWidth={150} />
        </View>
        <View style={{ marginTop: 16, gap: 12 }}>
          <Option value={history} onChange={setHistory} title="Browsing history" subtitle="Clears the pages you visited from History and the command bar." />
          <Option value={siteData} onChange={setSiteData} title="Cookies, site data and cached files" subtitle="Signs you out of most sites." />
        </View>
        {failed && (
          <Text style={{ fontSize: 12, marginTop: 14, color: theme.textSecondary }}>
            {history
              ? "History was cleared, but cookies, site data and cached files couldn't be. Try again."
              : "Cookies, site data and cached files couldn't be cleared. Try again."}
          </Text>
        )}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 22 }}>
          <Button title="Cancel" onPress={onClose} />
          <Button title="Clear Data" kind="primary" disabled={busy || (!history && !siteData)} onPress={() => void clear()} />
        </View>
      </Surface>
    </View>
  );
}

function Option({ value, onChange, title, subtitle }: { value: boolean; onChange: (v: boolean) => void; title: string; subtitle: string }) {
  const theme = useTheme();

  return (
    <View>
      <Checkbox value={value} onChange={onChange} label={title} />
      <Text style={{ fontSize: 11.5, marginLeft: 21, marginTop: 2, color: theme.textSecondary }}>{subtitle}</Text>
    </View>
  );
}
