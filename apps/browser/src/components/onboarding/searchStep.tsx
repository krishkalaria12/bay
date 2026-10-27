import { engineHost, type SearchEngine } from "@bay/core";
import { Symbol } from "@bay/shell";
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useBrowser } from "../../store/browser";
import { searchEngines, type Settings } from "../../store/settings";
import { Favicon } from "../primitives";
import { nextStep } from "./state";
import { QUARTER_TILE, StepLayout } from "./steps";
import { CheckRow, Reveal, SectionLabel, SelectTile, StepActions, StepTitle, useOnboardingColors } from "./ui";

// The engines offered here, two rows of four; the one you have already takes the last place if it isn't among them.
const ENGINES = ["google", "duckduckgo", "bing", "kagi", "ecosia", "brave", "perplexity", "startpage"];

const TYPED: { value: Settings["commandBarPreference"]; title: string; subtitle: string; picked: string }[] = [
  { value: "website", title: "Go to the site", subtitle: "“github” opens github.com", picked: "Typing a word goes to the site" },
  { value: "search", title: "Search for it", subtitle: "“github” searches the web", picked: "Typing a word searches for it" },
];

const engineUrl = (engine: SearchEngine) => `https://${engineHost(engine)}`;

export function SearchStep() {
  const all = useBrowser((s) => searchEngines(s.settings));
  const [engineId, setEngineId] = useState(() => useBrowser.getState().settings.searchEngine);
  const [typed, setTyped] = useState(() => useBrowser.getState().settings.commandBarPreference);
  const offered = ENGINES.map((id) => all.find((e) => e.id === id)).filter((e): e is SearchEngine => !!e);
  const current = all.find((e) => e.id === engineId);
  const engines = current && !offered.includes(current) ? [...offered.slice(0, ENGINES.length - 1), current] : offered;

  const done = () => {
    useBrowser.getState().updateSettings({ searchEngine: engineId, commandBarPreference: typed });
    nextStep([`Search with ${current?.name ?? "your engine"}`, TYPED.find((t) => t.value === typed)!.picked]);
  };

  return (
    <StepLayout actions={<StepActions onContinue={done} />} preview={<CommandBarPreview engine={current} typed={typed} />}>
      <Reveal delay={60}>
        <StepTitle title="Search with what?" subtitle="For anything you type that isn't a website." />
      </Reveal>
      <Reveal delay={140} style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel="Search engine">
          {engines.map((e) => (
            <SelectTile key={e.id} title={e.name} role="radio" width={QUARTER_TILE} height={60} selected={e.id === engineId} onPress={() => setEngineId(e.id)}>
              {() => <Favicon url={engineUrl(e)} size={18} />}
            </SelectTile>
          ))}
        </View>
        <View style={{ gap: 8 }}>
          <SectionLabel title="When you type a single word:" />
          <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="When you type a single word">
            {TYPED.map((t) => (
              <View key={t.value} style={{ flex: 1 }}>
                <CheckRow role="radio" title={t.title} subtitle={t.subtitle} value={typed === t.value} onChange={() => setTyped(t.value)} />
              </View>
            ))}
          </View>
        </View>
      </Reveal>
    </StepLayout>
  );
}

// The command bar with "github" typed: the site first or the search first, as you chose.
function CommandBarPreview({ engine, typed }: { engine: SearchEngine | undefined; typed: Settings["commandBarPreference"] }) {
  const colors = useOnboardingColors();
  const site = <Result key="site" icon={<Favicon url="https://github.com" size={14} />} title="github.com" detail="Open" highlighted={typed === "website"} />;
  const search = (
    <Result
      key="search"
      icon={
        engine ? (
          <Favicon url={engineUrl(engine)} size={14} />
        ) : (
          <Symbol name="magnifyingglass" size={11} color={colors.subtitle} style={{ width: 14, height: 14 }} />
        )
      }
      title="github"
      detail={`Search ${engine?.name ?? "the web"}`}
      highlighted={typed === "search"}
    />
  );
  return (
    <View
      style={{
        width: 300,
        padding: 8,
        gap: 4,
        borderRadius: 14,
        backgroundColor: colors.card,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.rowBorder,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 8 }}>
        <Symbol name="magnifyingglass" size={12} color={colors.subtitle} style={{ width: 16, height: 16 }} />
        <Text style={{ fontSize: 15, color: colors.title }}>github</Text>
        <View style={{ width: 1.5, height: 17, backgroundColor: colors.title }} />
      </View>
      <View style={{ height: StyleSheet.hairlineWidth * 2, backgroundColor: colors.separator, marginBottom: 4 }} />
      {typed === "website" ? [site, search] : [search, site]}
    </View>
  );
}

function Result({ icon, title, detail, highlighted }: { icon: ReactNode; title: string; detail: string; highlighted: boolean }) {
  const colors = useOnboardingColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        height: 34,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: highlighted ? colors.button : "transparent",
      }}
    >
      {icon}
      <Text style={{ flex: 1, fontSize: 13, fontWeight: highlighted ? "500" : "400", color: colors.title }}>{title}</Text>
      <Text style={{ fontSize: 11.5, color: colors.subtitle }}>{detail}</Text>
    </View>
  );
}
