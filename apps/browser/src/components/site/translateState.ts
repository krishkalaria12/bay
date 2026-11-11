// The app's view of a page's translation: what language it is in, and what the user asked for.
//
// The work is in pageWorkService.ts: the Mac's models, the page's passages, and the checks an engine switch makes
// before it moves a page. This is where the app reaches it, and where the state the app shows lives.
import { translation } from "@bay/desktop";
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import { useBrowser } from "../../store/browserStore";
import { isIncognitoSpace } from "../../store/model";
import { hideKeyedToast, showToast } from "../split/splitActions";
import { PageWorkService, baseLanguage, forgetSource, hostOf, translateStateOf, type PageWork } from "./pageWorkService";
import { TRANSLATE_PROGRESS_AFTER_MS, TRANSLATE_PROGRESS_TOAST } from "./constants";

export { baseLanguage, isNeverTranslated, translateStateOf, useTranslate, useTranslateState } from "./pageWorkService";

export type { TranslateState } from "./pageWorkService";

// MARK: Languages

let userLanguages: string[] | null = null;

function languages(): string[] {
  userLanguages ??= translation?.userLanguages() ?? [];

  return userLanguages;
}

/** The language the app translates into when the user has not chosen another one. */
export const defaultTarget = () => baseLanguage(languages()[0] ?? "en");

/** The name of a language, as the Mac writes it. */
export const languageName = (language: string) => translation?.languageName(language) ?? language;

// MARK: The work

/** Runs something with the page work, on the runtime the app shares. */
const withWork = <A>(program: (work: PageWork) => Effect.Effect<A>): Promise<A> =>
  runDesktop(
    Effect.gen(function* () {
      const work = yield* PageWorkService;

      return yield* program(work);
    }),
  );

function toast(tabId: string, title: string, message?: string, progress = false) {
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;

  if (!windowId) return;

  if (progress) showToast(windowId, title, message, { icon: "translate", key: TRANSLATE_PROGRESS_TOAST, sticky: true });
  else showToast(windowId, title, message, { icon: "translate" });
}

// MARK: Translating

/** Translates a page, and tells the user what came of it. */
export async function translatePage(tabId: string, target = defaultTarget()) {
  const windowId = useBrowser.getState().tabs[tabId]?.windowId;
  let shown = false;

  const outcome = await withWork((work) =>
    work.translate(tabId, {
      target,
      onProgress: (done, total, elapsed) => {
        if (elapsed < TRANSLATE_PROGRESS_AFTER_MS || total <= 0) return;
        shown = true;
        toast(tabId, `Translating to ${languageName(target)}…`, `${Math.min(99, Math.round((done / total) * 100))}%`, true);
      },
    }),
  );

  if (outcome.kind === "translated") toast(tabId, `Translated to ${languageName(outcome.target)}`);
  else if (outcome.kind === "unsupported")
    toast(tabId, `Translation error (${languageName(outcome.source)} to ${languageName(outcome.target)} isn't available)`);
  else if (outcome.kind === "same-language") toast(tabId, `Translation error (the page is already in ${languageName(outcome.target)})`);
  else if (outcome.kind === "unknown-language") toast(tabId, "Translation error (can't tell the page's language)");
  else if (outcome.kind === "failed") toast(tabId, `Translation error (${outcome.reason})`);

  // A translation that stopped leaves its progress behind.
  if (outcome.kind === "stopped" && shown && windowId) hideKeyedToast(windowId, TRANSLATE_PROGRESS_TOAST);
}

/** Puts a page's own text back. */
export async function revertPage(tabId: string, { quiet = false } = {}) {
  const outcome = await withWork((work) => work.revert(tabId));

  if (!quiet && outcome.source && outcome.translated) toast(tabId, `Translated back to ${languageName(outcome.source)}`);
}

/** Translates a page, or puts it back, whichever the page needs. */
export function toggleTranslation(tabId: string) {
  if (translateStateOf(tabId).status === "idle") void translatePage(tabId);
  else void revertPage(tabId);
}

/** The languages the Mac can translate into. */
export async function otherLanguages(): Promise<{ id: string; name: string }[]> {
  return withWork((work) => work.languages());
}

// MARK: Never Translate This Site (per profile; incognito windows follow their default profile's)

export function setNeverTranslate(tabId: string, never: boolean) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  const host = tab ? hostOf(tab.url) : "";

  if (!tab || !host || isIncognitoSpace(tab.spaceId)) return;
  const all = s.settings.neverTranslateSites;
  const list = (all[tab.spaceId] ?? []).filter((h) => h !== host);
  s.updateSettings({ neverTranslateSites: { ...all, [tab.spaceId]: never ? [...list, host] : list } });

  if (!never) return void detect(tabId);

  if (translateStateOf(tabId).status !== "idle") void revertPage(tabId, { quiet: true });
  forgetSource(tabId);
}

// MARK: Detection

/** Works out what language a page is in, and whether it can be translated. */
function detect(tabId: string) {
  return withWork((work) => work.detect(tabId)).catch(() => {});
}

// MARK: Wiring

/** Starts reading each page's language once it loads: the page work does it, in the app's scope. */
export function startTranslate() {
  void withWork((work) => work.start);
}
