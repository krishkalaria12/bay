// Tidy Tabs' own work: the model that proposes groups for a space's loose tabs, and the plan the store applies.
//
// A run belongs to one window and one space. The model is slow and the person keeps browsing, so what it planned is
// checked again before it is applied: a window that closed, a space that changed or tabs that moved leave the plan
// behind, and the tabs are grouped by their sites instead — which needs no model and no waiting.
//
// The plan itself stays plain (packages/core/src/tidyTabs.ts): it is the model's answer made safe, and it knows
// nothing about windows, stores or time.
import { MAX_TIDY_TABS, planTidyTabs, tidyTabsPrompt, type TidyProposal, type TidyTab } from "@bay/core";
import { tidyTabsModel, type TidyModelStatus } from "@bay/desktop";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { live } from "../activity/activityStore";
import type { Operation } from "../effect/errors";
import { useBrowser, type BrowserState } from "../store/browserStore";
import { groupLabel, hostOfTab, siteTidyPlan, tidyCandidates, type TabTidyPlan } from "../store/tabTidying";

// A quick answer doesn't flash: the wave runs at least this long.
const MINIMUM_RUN_MS = 900;

// MARK: The port

/** The Mac's model could not answer. */
export class TidyFailure extends TaggedError("TidyFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The Mac's own model, as the app reaches it. */
export class TidyEngine extends Context.Service<
  TidyEngine,
  {
    /** Where the model stands on this Mac: it can answer, or it cannot. */
    readonly status: () => Effect.Effect<TidyModelStatus, TidyFailure>;
    /** The model's groups for the prompt, or nothing when it cannot answer. */
    readonly group: (prompt: string) => Effect.Effect<TidyProposal[] | null, TidyFailure>;
  }
>()("bay/TidyEngine") {
  static readonly layer = Layer.succeed(TidyEngine)({
    status: () =>
      Effect.try({
        try: () => tidyTabsModel?.modelStatus() ?? "unavailable",
        catch: (cause) => new TidyFailure({ operation: { name: "tidy.status" }, cause }),
      }),
    group: (prompt) =>
      Effect.suspend(() => {
        const model = tidyTabsModel;

        // A build without the model groups the tabs by their sites instead.
        if (!model) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => model.group(prompt),
          catch: (cause) => new TidyFailure({ operation: { name: "tidy.group" }, cause }),
        });
      }),
  });
}

// MARK: What the app asks for

/** What the app asks for when it tidies a window's tabs. */
export type TidyRequest = {
  /** The window whose space is tidied. */
  readonly windowId: string;
  /** How long the wave runs at least, so a quick answer doesn't flash. */
  readonly minimumRunMs?: number;
};

/** What a Tidy run came to. */
export type TidyOutcome =
  /** The tabs were grouped. */
  | {
      readonly kind: "tidied";
      /** The groups that were made or added to. */
      readonly groups: number;
      /** The tabs that moved into them. */
      readonly moved: number;
      /** The tabs left loose, for the offer that waits for the next one. */
      readonly loose: readonly string[];
      /** Whether the model's plan or the grouping by site was applied. */
      readonly source: "model" | "site";
    }
  /** The tabs had too little in common to group. */
  | { readonly kind: "nothing"; readonly loose: readonly string[] }
  /** The window is gone, or it shows another space: nothing was applied. */
  | { readonly kind: "gone" }
  /** The space is being tidied already. */
  | { readonly kind: "busy" };

// MARK: The window a run belongs to

/** What a run holds of the window it tidies. */
type TidyRun = {
  readonly windowId: string;
  readonly spaceId: string;
  readonly incognito: boolean;
};

// Named groups the model may add to. A meeting's group closes with its meeting, and one a pinned tab opened belongs to it.
function joinableGroups(s: BrowserState, spaceId: string) {
  const meetings = live().meetingGroups;

  return Object.values(s.groups).filter((g) => g.spaceId === spaceId && !!g.name && !g.pinned && !g.pinnedOpenerId && !meetings[g.id]);
}

const tabForModel = (s: BrowserState, id: string): TidyTab => {
  const t = s.tabs[id]!;

  return { title: t.customTitle || t.title, host: hostOfTab(t) };
};

// MARK: The service

export class TidyWorkService extends Context.Service<
  TidyWorkService,
  {
    /** Tidies the loose tabs of the window's space: the model groups them, or their sites do. */
    readonly run: (request: TidyRequest) => Effect.Effect<TidyOutcome>;
  }
>()("bay/TidyWorkService") {
  static readonly layer = Layer.effect(
    TidyWorkService,
    Effect.gen(function* () {
      const engine = yield* TidyEngine;
      const clock = yield* Clock.Clock;

      // The spaces being tidied now: a space that is being sorted is not asked again.
      const tidying = new Set<string>();

      const tidy = (before: BrowserState, run: TidyRun, minimumRunMs: number): Effect.Effect<TidyOutcome> =>
        Effect.gen(function* () {
          const { windowId, spaceId, incognito } = run;
          const ids = tidyCandidates(before, windowId, spaceId).slice(0, MAX_TIDY_TABS);

          // The groups the model may add to, and the names it may reuse.
          const groups = joinableGroups(before, spaceId);
          const names = groups.map((g) => groupLabel(before, g));

          let plan: TabTidyPlan | null = null;

          // A private window's tabs don't go to the model, on this Mac or not.
          if (ids.length >= 2 && !incognito) {
            // The model's availability is asked once: it is not asked again while the model works, and a model
            // that cannot answer is not asked a second time.
            const status = yield* engine.status().pipe(Effect.catch(() => Effect.succeed<TidyModelStatus>("unavailable")));

            if (status === "available") {
              const started = clock.currentTimeMillisUnsafe();

              const prompt = tidyTabsPrompt(
                ids.map((id) => tabForModel(before, id)),
                names,
              );

              const answer = yield* engine.group(prompt).pipe(Effect.catch(() => Effect.succeed(null)));

              if (answer) {
                const made = planTidyTabs(answer, ids.length, names);
                const tabIds = (tabs: number[]) => tabs.map((tab) => ids[tab]!);

                plan = {
                  newGroups: made.newGroups.map((group) => ({ name: group.name, tabIds: tabIds(group.tabs) })),
                  joins: made.joins.map((join) => ({ groupId: groups[join.group]!.id, tabIds: tabIds(join.tabs) })),
                };
              }

              // The wave runs at least this long, so a quick answer doesn't flash.
              const left = minimumRunMs - (clock.currentTimeMillisUnsafe() - started);

              if (left > 0) yield* Effect.sleep(Duration.millis(left));
            }
          }

          const s = useBrowser.getState();

          // The window is gone: nothing is applied to a window that isn't there.
          if (!s.windows[windowId]) return yield* Effect.succeed({ kind: "gone" } as const);

          // The window shows another space now: the run belongs to the space it started in.
          if (s.windows[windowId]!.spaceId !== spaceId) return yield* Effect.succeed({ kind: "gone" } as const);

          // The tabs changed while the model thought: the plan it made is for other tabs, so it is not applied.
          const now = tidyCandidates(s, windowId, spaceId).slice(0, MAX_TIDY_TABS);
          const same = now.length === ids.length && now.every((id, i) => id === ids[i]);
          const modelPlan = same ? plan : null;
          const grouped = modelPlan !== null && (modelPlan.newGroups.length > 0 || modelPlan.joins.length > 0) ? modelPlan : null;
          const count = s.tidyTabs(windowId, grouped ?? siteTidyPlan(s, now));
          const after = useBrowser.getState();
          const loose = tidyCandidates(after, windowId, spaceId);

          if (!count) return yield* Effect.succeed({ kind: "nothing", loose } as const);

          // The tabs that moved are the ones now in a group: the plan may have left some behind.
          const inGroups = new Set(Object.values(after.groups).flatMap((g) => g.tabIds));

          return yield* Effect.succeed({
            kind: "tidied",
            groups: count,
            moved: now.filter((id) => inGroups.has(id)).length,
            loose,
            source: grouped ? "model" : "site",
          } as const);
        });

      const run = (request: TidyRequest): Effect.Effect<TidyOutcome> =>
        Effect.gen(function* () {
          const { windowId, minimumRunMs = MINIMUM_RUN_MS } = request;
          const before = useBrowser.getState();
          const w = before.windows[windowId];

          // The window is gone: there is nothing to tidy.
          if (!w) return yield* Effect.succeed({ kind: "gone" } as const);

          const scope: TidyRun = { windowId, spaceId: w.spaceId, incognito: w.incognito };

          // The space is being tidied: the model is not asked twice for the same tabs.
          if (tidying.has(scope.spaceId)) return yield* Effect.succeed({ kind: "busy" } as const);

          tidying.add(scope.spaceId);

          // The space is let go when the run ends, however it ends: a model that fails must not keep it.
          return yield* tidy(before, scope, minimumRunMs).pipe(Effect.ensuring(Effect.sync(() => void tidying.delete(scope.spaceId))));
        });

      return TidyWorkService.of({ run });
    }),
  );
}

/** What the tidy work can do. */
export type TidyWork = TidyWorkService["Service"];
