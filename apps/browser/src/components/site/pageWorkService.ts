// A page's own work: translating a document, and the check an engine switch makes before it moves one.
//
// A translation is a job: the Mac's models are prepared, the page's passages arrive in batches, and the page is
// followed so the text that shows up later is translated too. The job belongs to one document: a page that was
// replaced while a batch was in flight is never patched with the result, and a revert stops the following.
//
// The translator's own code stays plain (pageTranslator.ts): it is the script the page runs, and this file only
// decides when to ask the page for something.
import type { WebViewHandle } from "@bay/chromium";
import * as desktop from "@bay/desktop";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { create } from "zustand";
import * as v from "valibot";
import type { Operation } from "../../effect/errors";
import { useBrowser } from "../../store/browserStore";
import { isIncognitoSpace } from "../../store/model";
import { wantsPage } from "../../lib/tabNavigation";
import { webviews } from "../../lib/webviews";
import { TRANSLATE_BATCH, TRANSLATE_BATCH_CHARS, TRANSLATE_FOLLOW_MS } from "./constants";
import { translatorCall, type Passage } from "./pageTranslator";

// MARK: The state the app shows

/** What the app shows about a page's translation. */
export type TranslateState = {
  source: string | null;
  status: "idle" | "translating" | "translated";
  target: string | null;
  /** The token the running translation owns: a page that was translated again has another one. */
  token: string | null;
};

const IDLE: TranslateState = { source: null, status: "idle", target: null, token: null };

/** The translation state of every tab. */
export const useTranslate = create<Record<string, TranslateState | undefined>>()(() => ({}));

const stateOf = (tabId: string) => useTranslate.getState()[tabId] ?? IDLE;

/** The translation state of a tab. */
export const translateStateOf = stateOf;

const patch = (tabId: string, p: Partial<TranslateState>) => useTranslate.setState((s) => ({ [tabId]: { ...(s[tabId] ?? IDLE), ...p } }));

/** The translation state of a tab, for the app to show. */
export const useTranslateState = (tabId: string) => useTranslate((s) => s[tabId] ?? IDLE);

/** Forgets the language a page was translated from, without touching the page itself. */
export const forgetSource = (tabId: string) => patch(tabId, { source: null });

// MARK: Languages

/** The language a page is written in, as the app writes it. */
export function baseLanguage(language: string): string {
  const [lang = "", second] = language.split(/[-_]/);

  if (lang.toLowerCase() === "zh") return second && /^(hant|tw|hk|mo)$/i.test(second) ? "zh-Hant" : "zh-Hans";

  return lang.toLowerCase();
}

/** The site a page belongs to, when it is one the app shows. */
export function hostOf(url: string): string {
  try {
    return /^https?:$/.test(new URL(url).protocol) ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

// The sites the user never wants translated belong to a profile: an incognito window follows its default profile's.
function listOwner(spaceId: string): string {
  return isIncognitoSpace(spaceId) ? useBrowser.getState().settings.defaultSpaceId : spaceId;
}

/** Whether the user never wants this site translated. */
export function isNeverTranslated(spaceId: string, url: string): boolean {
  const host = hostOf(url);

  return !!host && (useBrowser.getState().settings.neverTranslateSites[listOwner(spaceId)] ?? []).includes(host);
}

// MARK: The port

/** The native side could not do what was asked. */
export class PageWorkFailure extends TaggedError("PageWorkFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** What the Mac can do with a pair of languages. */
export type TranslationStatus = "installed" | "supported" | "unsupported";

/** A translation, and the id the page knows the text by. */
export type AppliedText = readonly [number, string];

/** The passages the page is waiting to have translated. */
export type PageBatch = {
  readonly passages: Passage[];
  /** The page has passages waiting that it did not hand out yet. */
  readonly more: boolean;
  /** The document that answered is not the one the translation started on. */
  readonly gone: boolean;
  readonly done: number;
  readonly total: number;
};

/** What a page says about itself. */
export type PageSample = {
  readonly lang: string;
  readonly text: string;
  readonly active: boolean;
};

/** The page a tab is showing. */
export type PageView = {
  /** The token the page's translation runs under: a document that was replaced has another one, or none. */
  readonly identity: () => Effect.Effect<string | null, PageWorkFailure>;
  /** The page's language, its text, and whether it is being translated. */
  readonly sample: () => Effect.Effect<PageSample | null, PageWorkFailure>;
  /** Starts the translation of this document, and says whether the page was ready. */
  readonly start: (token: string) => Effect.Effect<boolean | null, PageWorkFailure>;
  /** The passages waiting to be translated. */
  readonly next: (token: string) => Effect.Effect<PageBatch | null, PageWorkFailure>;
  /** Puts the translations into the page. */
  readonly apply: (results: AppliedText[]) => Effect.Effect<boolean | null, PageWorkFailure>;
  /** Puts the page's own text back. */
  readonly revert: () => Effect.Effect<boolean | null, PageWorkFailure>;
  /** Whether the page holds input that a reload would lose. */
  readonly unsavedWork: () => Effect.Effect<boolean | null, PageWorkFailure>;
};

/** A question the app cannot answer itself. */
export type PageQuestion = {
  readonly title: string;
  readonly message: string;
  readonly confirmTitle: string;
  readonly cancelTitle: string;
  readonly windowId?: string;
};

/** The native side of a page's work: the Mac's translation, and the page a tab is showing. */
export class PageWorkEngine extends Context.Service<
  PageWorkEngine,
  {
    /** The page a tab is showing, or nothing when the tab has no view. */
    readonly view: (tabId: string) => Effect.Effect<PageView | null>;
    /** The languages the user reads. */
    readonly userLanguages: () => Effect.Effect<string[], PageWorkFailure>;
    /** The name of a language, as the Mac writes it. */
    readonly languageName: (language: string) => Effect.Effect<string, PageWorkFailure>;
    /** The language of a text, when the Mac can tell. */
    readonly detect: (text: string) => Effect.Effect<string | null, PageWorkFailure>;
    /** What the Mac can do with a pair of languages. */
    readonly status: (source: string, target: string) => Effect.Effect<TranslationStatus, PageWorkFailure>;
    /** The languages the Mac can translate. */
    readonly supportedLanguages: () => Effect.Effect<string[], PageWorkFailure>;
    /** Downloads the models a pair of languages needs. */
    readonly prepare: (source: string, target: string) => Effect.Effect<void, PageWorkFailure>;
    /** Translates a list of texts. */
    readonly translate: (source: string, target: string, texts: string[]) => Effect.Effect<string[], PageWorkFailure>;
    /** Translates blocks of text, keeping the pieces of a block together. */
    readonly translateBlocks: (source: string, target: string, blocks: string[][]) => Effect.Effect<(string[] | null)[], PageWorkFailure>;
    /** Asks the user a question the app cannot answer itself. */
    readonly ask: (question: PageQuestion) => Effect.Effect<boolean, PageWorkFailure>;
  }
>()("bay/PageWorkEngine") {
  static readonly layer = Layer.succeed(PageWorkEngine)({
    view: (tabId) =>
      Effect.suspend(() => {
        const handle = webviews.get(tabId);

        return Effect.succeed(handle ? viewOf(handle) : null);
      }),
    userLanguages: () => nativeCall("translation.userLanguages", () => desktop.translation?.userLanguages() ?? []),
    languageName: (language) => nativeCall("translation.languageName", () => desktop.translation?.languageName(language) ?? language),
    detect: (text) => nativeCall("translation.detect", () => desktop.translation?.detect(text) ?? Promise.resolve(null)),
    status: (source, target) => nativeCall("translation.status", () => desktop.translation?.status(source, target) ?? Promise.resolve("unsupported" as const)),
    supportedLanguages: () => nativeCall("translation.supportedLanguages", () => desktop.translation?.supportedLanguages() ?? Promise.resolve([])),
    prepare: (source, target) => nativeCall("translation.prepare", () => desktop.translation?.prepare(source, target) ?? Promise.resolve()),
    translate: (source, target, texts) =>
      nativeCall("translation.translate", () => desktop.translation?.translate(source, target, texts) ?? Promise.resolve([])),
    translateBlocks: (source, target, blocks) =>
      nativeCall("translation.translateBlocks", () => desktop.translation?.translateBlocks(source, target, blocks) ?? Promise.resolve([])),
    ask: (question) =>
      nativeCall("page.ask", async () => {
        const answer = await desktop.confirm({
          title: question.title,
          message: question.message,
          confirmTitle: question.confirmTitle,
          cancelTitle: question.cancelTitle,
          windowId: question.windowId,
        });

        return answer.confirmed;
      }),
  });
}

// MARK: The native side

/** The page's own answer to whether it holds input that a reload would lose. */
const UNSAVED_WORK = `(() => {
  const fields = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]), textarea, select"));
  const changed = (f) => f.type === "checkbox" || f.type === "radio" ? f.checked !== f.defaultChecked : f.tagName === "SELECT" ? Array.from(f.options).some((o) => o.selected !== o.defaultSelected) : f.value !== f.defaultValue;
  const editing = document.activeElement && document.activeElement.isContentEditable;
  post("result", JSON.stringify(fields.some(changed) || !!editing));
})()`;

/** How long the app waits for a page to say whether it holds unsaved work. */
const UNSAVED_WORK_TIMEOUT_MS = 1_500;

/** A native call, with its failure named. */
function nativeCall<A>(operation: string, run: () => A | Promise<A>): Effect.Effect<A, PageWorkFailure> {
  return Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new PageWorkFailure({ operation: { name: operation }, cause }),
  });
}

/** A page, as the service reaches it. */
function viewOf(handle: WebViewHandle): PageView {
  const ask = <T>(code: string, operation: string): Effect.Effect<T | null, PageWorkFailure> =>
    Effect.tryPromise({
      try: () => handle.evaluate<T>(code),
      catch: (cause) => new PageWorkFailure({ operation: { name: operation }, cause }),
    });

  return {
    identity: () => ask<string>(translatorCall("identity"), "page.identity"),
    sample: () => ask<PageSample>(translatorCall("sample"), "page.sample"),
    start: (token) => ask<boolean>(translatorCall("start", token), "page.start"),
    next: (token) => ask<PageBatch>(translatorCall("next", token, TRANSLATE_BATCH, TRANSLATE_BATCH_CHARS), "page.next"),
    apply: (results) => ask<boolean>(translatorCall("apply", results), "page.apply"),
    revert: () => ask<boolean>(translatorCall("revert"), "page.revert"),
    unsavedWork: () => ask<boolean>(UNSAVED_WORK, "page.unsavedWork"),
  };
}

// MARK: What the app asks for

/** What the app asks for when it translates a page. */
export type TranslateRequest = {
  /** The language to translate into. */
  readonly target: string;
  /** Told how far the translation has come, and how long it has been at it. */
  readonly onProgress?: (done: number, total: number, elapsedMs: number) => void;
};

/** What came of a translation the app asked for. */
export type TranslationOutcome =
  | { readonly kind: "translated"; readonly target: string }
  | { readonly kind: "unsupported"; readonly source: string; readonly target: string }
  | { readonly kind: "same-language"; readonly target: string }
  | { readonly kind: "unknown-language" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly reason: string };

/** What came of putting a page's own text back. */
export type RevertOutcome = {
  /** The language the page was translated from, when it was translated. */
  readonly source: string | null;
  /** Whether the page was translated when the revert began. */
  readonly translated: boolean;
};

/** A language the Mac can translate into. */
export type LanguageOption = {
  readonly id: string;
  readonly name: string;
};

// MARK: The service

/** A translation that is running, and the document it belongs to. */
type Job = {
  readonly tabId: string;
  readonly token: string;
  readonly view: PageView;
  readonly source: string;
  readonly target: string;
};

export class PageWorkService extends Context.Service<
  PageWorkService,
  {
    /** Translates a page, and says what came of it. */
    readonly translate: (tabId: string, request: TranslateRequest) => Effect.Effect<TranslationOutcome>;
    /** Puts a page's own text back. */
    readonly revert: (tabId: string) => Effect.Effect<RevertOutcome>;
    /** Works out what language a page is in, and whether it can be translated. */
    readonly detect: (tabId: string) => Effect.Effect<void>;
    /** The languages the Mac can translate into. */
    readonly languages: () => Effect.Effect<LanguageOption[]>;
    /** Whether the page holds input that a reload in another engine would lose. */
    readonly unsavedWork: (tabId: string) => Effect.Effect<boolean>;
    /** Whether the page may move to another engine, asking the user when it holds work. */
    readonly mayLeavePage: (tabId: string, question: PageQuestion) => Effect.Effect<boolean>;
  }
>()("bay/PageWorkService") {
  static readonly layer = Layer.effect(
    PageWorkService,
    Effect.gen(function* () {
      const engine = yield* PageWorkEngine;
      const scope = yield* Scope.Scope;

      // The translation running for a tab, and the loop that follows the page while it runs.
      const jobs = new Map<string, Job>();
      const followers = new Map<string, Fiber.Fiber<void, never>>();

      // The state still carries the job's token: a new translation, a revert or a closed tab ends the old one.
      const ours = (job: Job) => stateOf(job.tabId).token === job.token;

      // The page is still the document the translation started on. A page that was replaced has another identity,
      // and a page that cannot answer is not the page either.
      const samePage = (job: Job): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (!ours(job)) return yield* Effect.succeed(false);

          const identity = yield* job.view.identity();

          return yield* Effect.succeed(identity === job.token);
        }).pipe(Effect.catch(() => Effect.succeed(false)));

      // The translations of one batch: the blocks the Mac kept together first, the rest one by one.
      const translatePassages = (job: Job, passages: Passage[]): Effect.Effect<AppliedText[], PageWorkFailure> =>
        Effect.gen(function* () {
          const texts = passages.map(([, pieces]) => pieces.map(([, text]) => text));
          const whole = yield* engine.translateBlocks(job.source, job.target, texts);
          const out: AppliedText[] = [];
          const loose: [number, string][] = [];

          passages.forEach(([, pieces], i) => {
            const parts = whole[i];

            if (parts && parts.length === pieces.length) pieces.forEach(([id], j) => out.push([id, parts[j] ?? ""]));
            else loose.push(...pieces);
          });

          if (loose.length) {
            const looseTexts = yield* engine.translate(
              job.source,
              job.target,
              loose.map(([, text]) => text),
            );

            loose.forEach(([id], i) => out.push([id, looseTexts[i] ?? ""]));
          }

          return yield* Effect.succeed(out);
        });

      // One run of the page's passages: what is translated, and whether the page has more to give.
      const drain = (job: Job, onProgress?: (done: number, total: number, elapsedMs: number) => void): Effect.Effect<boolean, PageWorkFailure> =>
        Effect.gen(function* () {
          const startedAt = Date.now();

          for (;;) {
            if (!ours(job)) return yield* Effect.succeed(false);

            const batch = yield* job.view.next(job.token);

            if (!batch || batch.gone || !Array.isArray(batch.passages)) return yield* Effect.succeed(false);

            // The document was replaced while the batch was on its way.
            if (!(yield* samePage(job))) return yield* Effect.succeed(false);

            const passages = batch.passages
              .slice(0, TRANSLATE_BATCH * 4)
              .filter((p): p is Passage => Array.isArray(p) && Array.isArray(p[1]))
              .map(([id, pieces]): Passage => [id, pieces.filter((x) => Array.isArray(x) && v.is(v.string(), x[1])).slice(0, 40)]);

            if (passages.length) {
              const results = yield* translatePassages(job, passages);

              // The document was replaced while the passages were translated: the result belongs to another page.
              if (!(yield* samePage(job))) return yield* Effect.succeed(false);

              yield* job.view.apply(results);
            }

            onProgress?.(batch.done, batch.total, Date.now() - startedAt);

            if (!batch.more) return yield* Effect.succeed(true);
          }
        });

      // The page keeps changing while it is read: the translation follows it until the document is replaced.
      const follow = (job: Job): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(Duration.millis(TRANSLATE_FOLLOW_MS));

            if (!ours(job)) return;

            const drained = yield* drain(job).pipe(Effect.catch(() => Effect.succeed(false)));

            // The page has nothing left for now: it is followed until the document is replaced.
            if (drained) continue;

            if (!ours(job)) return;

            // The document is still ours: the page is only busy, and the following goes on.
            if (yield* samePage(job)) continue;

            yield* Effect.sync(() => patch(job.tabId, { status: "idle", target: null, token: null }));

            return;
          }
        }).pipe(
          Effect.catchCause(() => Effect.void),
          // A follow that ended lets go of its job: a closed tab or a replaced document leaves nothing behind.
          Effect.ensuring(
            Effect.sync(() => {
              if (jobs.get(job.tabId) !== job) return;

              jobs.delete(job.tabId);
              followers.delete(job.tabId);
            }),
          ),
        );

      // The language a page is written in, when the Mac can tell.
      const pageLanguage = (view: PageView): Effect.Effect<string | null> =>
        Effect.gen(function* () {
          const sample = yield* view.sample().pipe(Effect.catch(() => Effect.succeed(null)));

          if (!sample) return yield* Effect.succeed(null);

          const detected = sample.text.length >= 40 ? yield* engine.detect(sample.text.slice(0, 3000)).pipe(Effect.catch(() => Effect.succeed(null))) : null;

          return yield* Effect.succeed(detected ?? (sample.lang ? sample.lang.slice(0, 20) : null));
        });

      const revert = (tabId: string): Effect.Effect<RevertOutcome> =>
        Effect.gen(function* () {
          const { source, status } = stateOf(tabId);

          patch(tabId, { status: "idle", target: null, token: null });

          jobs.delete(tabId);

          // The following stops with the translation it was following.
          const follower = followers.get(tabId);

          if (follower) {
            followers.delete(tabId);

            yield* Fiber.interrupt(follower);
          }

          const view = yield* engine.view(tabId);

          if (view) yield* view.revert().pipe(Effect.catch(() => Effect.succeed(false)));

          return yield* Effect.succeed({ source, translated: status !== "idle" });
        });

      const runTranslation = (tabId: string, view: PageView, source: string, request: TranslateRequest): Effect.Effect<TranslationOutcome, PageWorkFailure> =>
        Effect.gen(function* () {
          const status = yield* engine.status(source, request.target);

          if (status === "unsupported") return yield* Effect.succeed({ kind: "unsupported", source, target: request.target } as const);

          if (status === "supported") yield* engine.prepare(source, request.target);

          const token = Math.random().toString(36).slice(2);
          const job: Job = { tabId, token, view, source, target: request.target };

          patch(tabId, { status: "translating", source, target: request.target, token });

          jobs.set(tabId, job);

          if (!(yield* view.start(token))) {
            return yield* Effect.fail(
              new PageWorkFailure({ operation: { name: "translate.start", resource: tabId }, cause: new Error("the page isn't ready") }),
            );
          }

          const done = yield* drain(job, request.onProgress);

          if (!done) {
            if (jobs.get(tabId) === job) jobs.delete(tabId);

            if (ours(job)) patch(tabId, { status: "idle", target: null, token: null });

            return yield* Effect.succeed({ kind: "stopped" } as const);
          }

          patch(tabId, { status: "translated" });

          // The page keeps changing: the translation follows it, in the app's scope.
          const follower = yield* Effect.forkIn(follow(job), scope);

          followers.set(tabId, follower);

          return yield* Effect.succeed({ kind: "translated", target: request.target } as const);
        });

      const translate = (tabId: string, request: TranslateRequest): Effect.Effect<TranslationOutcome> =>
        Effect.gen(function* () {
          const tab = useBrowser.getState().tabs[tabId];

          if (!tab || !hostOf(tab.url)) return yield* Effect.succeed({ kind: "unavailable" } as const);

          const view = yield* engine.view(tabId);

          if (!view) return yield* Effect.succeed({ kind: "unavailable" } as const);

          // A translation starts from the page's own text.
          yield* revert(tabId);

          const source = stateOf(tabId).source ?? (yield* pageLanguage(view));

          if (!source) return yield* Effect.succeed({ kind: "unknown-language" } as const);

          if (baseLanguage(source) === baseLanguage(request.target)) return yield* Effect.succeed({ kind: "same-language", target: request.target } as const);

          const outcome = yield* Effect.exit(runTranslation(tabId, view, source, request));

          if (Exit.isFailure(outcome)) {
            yield* revert(tabId);

            return yield* Effect.succeed({ kind: "failed", reason: reasonOf(outcome.cause) } as const);
          }

          return yield* Effect.succeed(outcome.value);
        });

      const detect = (tabId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const tab = useBrowser.getState().tabs[tabId];

          if (!tab || !hostOf(tab.url)) {
            patch(tabId, { source: null, status: "idle", target: null, token: null });

            return;
          }

          const view = yield* engine.view(tabId);

          if (!view) return;

          const sample = yield* view.sample().pipe(Effect.catch(() => Effect.succeed(null)));

          if (!sample) return;

          // The document was replaced: the translation is over.
          if (!sample.active && stateOf(tabId).status === "translated") patch(tabId, { status: "idle", target: null, token: null });

          if (isNeverTranslated(tab.spaceId, tab.url)) {
            patch(tabId, { source: null });

            return;
          }

          const languages = yield* engine.userLanguages().pipe(Effect.catch(() => Effect.succeed<string[]>([])));
          const mine = new Set(languages.map(baseLanguage));
          const detected = sample.text.length >= 40 ? yield* engine.detect(sample.text.slice(0, 3000)).pipe(Effect.catch(() => Effect.succeed(null))) : null;
          const language = detected ?? (sample.lang ? sample.lang.slice(0, 20) : null);
          const source = language && !mine.has(baseLanguage(language)) ? language : null;

          if (source) {
            const target = baseLanguage(languages[0] ?? "en");
            const status = yield* engine.status(source, target).pipe(Effect.catch(() => Effect.succeed<TranslationStatus>("supported")));

            if (status === "unsupported") {
              patch(tabId, { source: null });

              return;
            }
          }

          if (stateOf(tabId).status === "idle") patch(tabId, { source });
        });

      const languages = (): Effect.Effect<LanguageOption[]> =>
        Effect.gen(function* () {
          const ids = yield* engine.supportedLanguages().pipe(Effect.catch(() => Effect.succeed<string[]>([])));
          const best = new Map<string, string>();

          for (const id of ids) {
            const key = baseLanguage(id);
            const current = best.get(key);

            if (!current || id.length < current.length) best.set(key, id);
          }

          const options: LanguageOption[] = [];

          for (const id of best.values()) {
            const name = yield* engine.languageName(id).pipe(Effect.catch(() => Effect.succeed(id)));

            options.push({ id, name });
          }

          options.sort((a, b) => a.name.localeCompare(b.name));

          return yield* Effect.succeed(options);
        });

      // Whether the page holds input that a reload in another engine would lose.
      const unsavedWork = (tabId: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const view = yield* engine.view(tabId);

          if (!view) return yield* Effect.succeed(false);

          const answer = yield* view.unsavedWork().pipe(
            Effect.timeout(Duration.millis(UNSAVED_WORK_TIMEOUT_MS)),
            Effect.catch(() => Effect.succeed(false)),
          );

          return yield* Effect.succeed(answer === true);
        });

      // The page moves to another engine only when the user says so.
      const mayLeavePage = (tabId: string, question: PageQuestion): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const tab = useBrowser.getState().tabs[tabId];

          if (!wantsPage(tab)) return yield* Effect.succeed(true);

          if (!(yield* unsavedWork(tabId))) return yield* Effect.succeed(true);

          const answer = yield* engine.ask(question).pipe(Effect.catch(() => Effect.succeed(false)));

          return yield* Effect.succeed(answer);
        });

      return PageWorkService.of({ translate, revert, detect, languages, unsavedWork, mayLeavePage });
    }),
  );
}

/** What the page work can do. */
export type PageWork = PageWorkService["Service"];

/** What went wrong, in words the app can show. */
function reasonOf(cause: Cause.Cause<PageWorkFailure>): string {
  const squashed = Cause.squash(cause);
  const message = squashed instanceof Error ? squashed.message : String(squashed);

  return message.replace(/[.\s]+$/, "");
}
