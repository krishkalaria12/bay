import * as v from "valibot";
import { BANG_PLACEHOLDER, isValidBangTemplate } from "./bangs.ts";
import { hostOf, searchUrlFor } from "./input.ts";
import { isJsonObject, type JsonValue } from "./json.ts";

export type SearchEngine = {
  id: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl?: string;
  custom?: boolean;
  extension?: { id: string; name: string };
};

export type CustomSearchEngine = { id: string; name: string; keyword: string; url: string };

export type ExtensionSearchEngine = {
  profile: string;
  extensionId: string;
  extensionName: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl?: string;
  isDefault: boolean;
};

export const BUILT_IN_ENGINES: readonly SearchEngine[] = [
  {
    id: "google",
    name: "Google",
    keyword: "google.com",
    url: "https://www.google.com/search?q=%s",
    suggestUrl: "https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s",
  },
  { id: "bing", name: "Bing", keyword: "bing.com", url: "https://www.bing.com/search?q=%s", suggestUrl: "https://api.bing.com/osjson.aspx?query=%s" },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    keyword: "duckduckgo.com",
    url: "https://duckduckgo.com/?q=%s",
    suggestUrl: "https://duckduckgo.com/ac/?q=%s&type=list",
  },
  { id: "perplexity", name: "Perplexity", keyword: "perplexity.ai", url: "https://www.perplexity.ai/search?q=%s" },
  { id: "chatgpt", name: "ChatGPT", keyword: "chatgpt.com", url: "https://chatgpt.com/?q=%s" },
  {
    id: "ecosia",
    name: "Ecosia",
    keyword: "ecosia.org",
    url: "https://www.ecosia.org/search?q=%s",
    suggestUrl: "https://ac.ecosia.org/autocomplete?q=%s&type=list",
  },
  {
    id: "brave",
    name: "Brave Search",
    keyword: "search.brave.com",
    url: "https://search.brave.com/search?q=%s",
    suggestUrl: "https://search.brave.com/api/suggest?q=%s",
  },
  { id: "kagi", name: "Kagi", keyword: "kagi.com", url: "https://kagi.com/search?q=%s" },
  {
    id: "startpage",
    name: "Startpage",
    keyword: "startpage.com",
    url: "https://www.startpage.com/do/search?q=%s",
    suggestUrl: "https://www.startpage.com/osuggestions?q=%s",
  },
  {
    id: "yahoo",
    name: "Yahoo",
    keyword: "yahoo.com",
    url: "https://search.yahoo.com/search?p=%s",
    suggestUrl: "https://search.yahoo.com/sugg/ff?output=fxjson&command=%s",
  },
  {
    id: "baidu",
    name: "Baidu",
    keyword: "baidu.com",
    url: "https://www.baidu.com/s?wd=%s",
    suggestUrl: "https://www.baidu.com/su?action=opensearch&ie=utf-8&wd=%s",
  },
  {
    id: "yandex",
    name: "Yandex",
    keyword: "yandex.com",
    url: "https://yandex.com/search/?text=%s",
    suggestUrl: "https://suggest.yandex.com/suggest-ff.cgi?part=%s",
  },
];

export function allEngines(custom: readonly CustomSearchEngine[] = [], extension: readonly ExtensionSearchEngine[] = []): SearchEngine[] {
  const engines: SearchEngine[] = [...BUILT_IN_ENGINES, ...custom.map((e) => ({ ...e, custom: true }))];
  const seen = new Set<string>();

  for (const e of extension) {
    if (seen.has(e.extensionId)) continue;
    seen.add(e.extensionId);
    engines.push({
      id: extensionEngineId(e.extensionId),
      name: e.name,
      keyword: e.keyword,
      url: e.url,
      suggestUrl: e.suggestUrl || undefined,
      extension: { id: e.extensionId, name: e.extensionName },
    });
  }

  return engines;
}

export const extensionEngineId = (extensionId: string) => `extension:${extensionId}`;

export function controllingExtensionEngine(extension: readonly ExtensionSearchEngine[]): ExtensionSearchEngine | undefined {
  return extension.find((e) => e.isDefault);
}

const withoutPlaceholders = (url: string) => url.replace(/\{[^{}%]*\}/g, "");

// A search engine's extension as Chrome records it; the rest of the row is read field by field below.
interface ChromeExtensionRef {
  id: string;
  name?: JsonValue;
}

const isChromeExtensionRef = (value: unknown): value is ChromeExtensionRef => v.is(v.object({ id: v.string() }), value);

export function extensionEnginesFromChrome(profile: string, list: JsonValue | null | undefined): ExtensionSearchEngine[] {
  const groups = isJsonObject(list) ? Object.values(list) : [];
  const out: ExtensionSearchEngine[] = [];

  for (const group of groups) {
    if (!Array.isArray(group)) continue;

    for (const row of group) {
      if (!isJsonObject(row)) continue;
      const ext = row.extension;

      if (!isChromeExtensionRef(ext) || row.isOmniboxExtension) continue;

      if (!v.is(v.string(), row.url) || !row.url.includes("%s") || out.some((o) => o.extensionId === ext.id)) continue;
      out.push({
        profile,
        extensionId: ext.id,
        extensionName: v.is(v.string(), ext.name) ? ext.name : "",
        name: v.is(v.string(), row.name) && row.name ? row.name : String(ext.name ?? ""),
        keyword: v.is(v.string(), row.keyword) ? row.keyword : "",
        url: withoutPlaceholders(row.url),
        suggestUrl: v.is(v.string(), row.suggestionsUrl) && row.suggestionsUrl.includes("%s") ? withoutPlaceholders(row.suggestionsUrl) : undefined,
        isDefault: row.default === true,
      });
    }
  }

  return out;
}

export function engineById(engines: readonly SearchEngine[], id: string | undefined): SearchEngine {
  return engines.find((e) => e.id === id) ?? BUILT_IN_ENGINES[0]!;
}

export const searchUrl = (engine: Pick<SearchEngine, "url">, query: string) => searchUrlFor(engine.url, query);

export const suggestRequestUrl = (engine: SearchEngine, query: string) => (engine.suggestUrl && query.trim() ? searchUrlFor(engine.suggestUrl, query) : null);

export const engineHost = (engine: Pick<SearchEngine, "url">) => hostOf(engine.url.replace(/%s/g, "q"));

export function parseSuggestions(body: JsonValue): string[] {
  if (!Array.isArray(body)) return [];
  const suggestions = body[1];

  if (!Array.isArray(suggestions)) return [];

  return suggestions.flatMap((s) => (v.is(v.string(), s) && s.trim() !== "" ? [s.trim()] : []));
}

export type EngineInput = { name: string; keyword: string; url: string };

export function validateEngine(input: EngineInput, engines: readonly SearchEngine[], ignoreId?: string): string | null {
  const name = input.name.trim();
  const keyword = input.keyword.trim().toLowerCase();
  const url = input.url.trim();

  if (!name) return "Enter a name.";

  if (!keyword) return "Enter a shortcut.";

  if (/\s/.test(keyword)) return "The shortcut can't contain spaces.";

  if (keyword.includes("!")) return "Enter the shortcut without !, for example yt for !yt.";

  if (!/^https?:\/\/[^/?#\s]+/i.test(url)) return "Enter a URL that starts with http:// or https://.";

  if (!url.includes("%s")) return "The URL must contain %s where the search terms go.";

  if (!isValidBangTemplate(url.split("%s").join(BANG_PLACEHOLDER))) return "Use a fixed website address, with %s only in the path, query or fragment.";

  if (engines.some((e) => e.id !== ignoreId && e.keyword.toLowerCase() === keyword)) return `“${keyword}” is already used by another search engine.`;

  return null;
}

export function makeCustomEngine(input: EngineInput, id: string): CustomSearchEngine {
  return { id, name: input.name.trim(), keyword: input.keyword.trim().toLowerCase(), url: input.url.trim() };
}
