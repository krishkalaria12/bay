import { isMac } from "@bay/platform";
import { getSpellCheck, setSpellCheckEnabled, setSpellCheckLanguages } from "@bay/chromium";
import { useEffect, useState } from "react";
import { useBrowserRead } from "../../../store/read";
import { engineProfile } from "../../../store/model";
import { Checkbox, Group, Row, SectionHeader, Toggle } from "../controls";
import { SETTINGS } from "../definitions";

// Settings › General › Spelling: Chromium's spell checker in every space (each space's engine profile keeps its own
// prefs, so a change goes to all of them). macOS checks with the Mac's own languages (System Settings › Keyboard ›
// Text Input); Windows and Linux take the languages here.

export const SPELLING_LANGUAGES = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["hi", "Hindi"],
] as const;

export function SpellingSection() {
  const spaces = useBrowserRead((s) => s.spaceOrder);
  const profiles = [...new Set(spaces.map(engineProfile))];
  const first = profiles[0] ?? "";
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void getSpellCheck(first)
      .then((check) => {
        if (!live) return;
        setEnabled(check.enabled);
        setLanguages(check.languages);
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [first]);

  if (enabled === null) return null;

  const turn = (on: boolean) => {
    setEnabled(on);

    for (const profile of profiles) void setSpellCheckEnabled(profile, on).catch(() => {});
  };

  const pick = (language: string, on: boolean) => {
    const next = on ? [...languages.filter((l) => l !== language), language] : languages.filter((l) => l !== language);
    setLanguages(next);

    for (const profile of profiles) void setSpellCheckLanguages(profile, next).catch(() => {});
  };

  return (
    <>
      <SectionHeader title="Spelling" />
      <Group>
        <Row
          settingId={SETTINGS.spellCheck.id}
          title={SETTINGS.spellCheck.title}
          description={isMac ? "Uses the languages in System Settings › Keyboard › Text Input." : "Underlines misspelled words in text fields on pages."}
        >
          <Toggle value={enabled} onChange={turn} />
        </Row>
        {!isMac &&
          enabled &&
          SPELLING_LANGUAGES.map(([code, name]) => (
            <Row key={code} title={<Checkbox value={languages.includes(code)} onChange={(on) => pick(code, on)} label={name} />} />
          ))}
      </Group>
    </>
  );
}
