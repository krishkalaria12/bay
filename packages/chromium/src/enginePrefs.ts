import * as v from "valibot";
import { engineCall } from "./engineInfo";

// Chrome preferences the app owns, through the engine's nn_prefs (engine/chromium nn_prefs.h): the browser-wide
// Secure DNS settings and each profile's spell checking. The same on macOS, Windows and Linux.

export type SecureDnsMode = "off" | "automatic" | "secure";

export type SecureDns = { mode: SecureDnsMode; templates: string; managed: boolean };

const PrefReply = v.object({ value: v.unknown(), managed: v.optional(v.boolean()) });
const ModeSchema = v.picklist(["off", "automatic", "secure"]);

async function pref(name: string, profile = "") {
  return v.parse(PrefReply, await engineCall("nn_prefs_get", profile, { name }));
}

/** The browser's DNS-over-HTTPS setting: Chrome's mode and, for "secure", the server's URI templates. */
export async function getSecureDns(): Promise<SecureDns> {
  const [mode, templates] = await Promise.all([pref("dns_over_https.mode"), pref("dns_over_https.templates")]);
  const parsed = v.safeParse(ModeSchema, mode.value);

  return {
    mode: parsed.success ? parsed.output : "automatic",
    templates: v.is(v.string(), templates.value) ? templates.value : "",
    managed: !!mode.managed || !!templates.managed,
  };
}

/** Sets DNS over HTTPS for every profile; `templates` only matters in "secure". */
export async function setSecureDns(mode: SecureDnsMode, templates = "") {
  await engineCall("nn_prefs_set", "", { name: "dns_over_https.templates", value: mode === "secure" ? templates : "" });
  await engineCall("nn_prefs_set", "", { name: "dns_over_https.mode", value: mode });
}

export type SpellCheck = { enabled: boolean; languages: string[] };

/** A profile's spell checking: on or off, and the languages it checks. */
export async function getSpellCheck(profile: string): Promise<SpellCheck> {
  const [enabled, languages] = await Promise.all([pref("browser.enable_spellchecking", profile), pref("spellcheck.dictionaries", profile)]);
  const list = v.safeParse(v.array(v.string()), languages.value);

  return { enabled: enabled.value !== false, languages: list.success ? list.output : [] };
}

export const setSpellCheckEnabled = (profile: string, enabled: boolean) =>
  engineCall("nn_prefs_set", profile, { name: "browser.enable_spellchecking", value: enabled });

export const setSpellCheckLanguages = (profile: string, languages: string[]) =>
  engineCall("nn_prefs_set", profile, { name: "spellcheck.dictionaries", value: languages });

// Spelling's own words: a profile's custom dictionary (engine nn_spelling.h), which "Add to Dictionary" fills.
const SpellWordsReply = v.object({ words: v.array(v.string()), loaded: v.boolean() });

export const spellingWords = async (profile: string) => v.parse(SpellWordsReply, await engineCall("nn_spell_words", profile, {}));

export const setSpellingWord = async (profile: string, word: string, add: boolean) =>
  v.parse(v.object({ changed: v.boolean() }), await engineCall("nn_spell_word", profile, { word, add })).changed;
