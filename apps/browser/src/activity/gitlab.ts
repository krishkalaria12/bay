import { lookup } from "@bay/core";
import * as v from "valibot";
import type { JsonValue } from "../lib/json";
import type { CheckState, CompletionState, LiveItem, PullRequestInfo, PullRequestSection } from "./types";

// GitLab merge requests (REST v4) on gitlab.com or a self-managed site: the person's own open ones and the ones
// waiting on their review, each with its head pipeline. A personal access token with read_api reads them.

export const GITLAB_SITE = "https://gitlab.com";

/** A site as typed ("gitlab.example.com/", "https://gitlab.com") as its https base, or null if it isn't one. */
export function gitlabBase(site: string): string | null {
  const typed = site.trim().replace(/\/+$/, "") || GITLAB_SITE;

  try {
    const url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);

    return url.protocol === "https:" && !url.search && !url.hash ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

export type GitlabUser = { id: number; username: string; name: string; avatar_url?: string | null };

export type GitlabMergeRequest = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: "opened" | "closed" | "locked" | "merged";
  draft?: boolean;
  work_in_progress?: boolean;
  updated_at: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  user_notes_count: number;
  has_conflicts?: boolean;
  blocking_discussions_resolved?: boolean;
  detailed_merge_status?: string;
  author: { name: string; avatar_url?: string | null };
  references?: { full?: string };
  // The single merge request's answer only.
  head_pipeline?: { status: string; web_url: string } | null;
  changes_count?: string | null;
};

const PIPELINE_STATES = {
  success: "success",
  failed: "failure",
  running: "pending",
  pending: "pending",
  created: "pending",
  preparing: "pending",
  waiting_for_resource: "pending",
  waiting_for_callback: "pending",
  scheduled: "queued",
} satisfies Record<string, CheckState>;

/** The project's path, from its reference ("group/project!12") or its address. */
function projectOf(mr: GitlabMergeRequest): string {
  const full = mr.references?.full;

  if (full?.includes("!")) return full.slice(0, full.lastIndexOf("!"));

  return mr.web_url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/-\/merge_requests\/\d+.*$/, "");
}

/** What REST leaves out of a merge request: its line counts and who approved it (GitLab's GraphQL has both). */
export type GitlabStats = { additions: number; deletions: number; approved: boolean; approvedBy: string[] };

/** One GraphQL query for every merge request's stats, each under its own alias (m0, m1…). */
export function gitlabStatsQuery(mrs: readonly GitlabMergeRequest[]): string {
  const parts = mrs.map(
    (mr, i) =>
      `m${i}: project(fullPath: ${JSON.stringify(projectOf(mr))}) { mergeRequest(iid: ${JSON.stringify(String(mr.iid))}) { approved approvedBy { nodes { name } } diffStatsSummary { additions deletions } } }`,
  );

  return `query { ${parts.join(" ")} }`;
}

const StatsAnswerSchema = v.object({
  data: v.nullish(
    v.record(
      v.string(),
      v.nullish(
        v.object({
          mergeRequest: v.nullish(
            v.object({
              approved: v.nullish(v.boolean()),
              approvedBy: v.nullish(v.object({ nodes: v.array(v.object({ name: v.string() })) })),
              diffStatsSummary: v.nullish(v.object({ additions: v.number(), deletions: v.number() })),
            }),
          ),
        }),
      ),
    ),
  ),
});

/** The answer to gitlabStatsQuery, in the merge requests' order; null for one GitLab didn't answer for. */
export function gitlabStats(answer: JsonValue, count: number): (GitlabStats | null)[] {
  const parsed = v.safeParse(StatsAnswerSchema, answer);
  const data = parsed.success ? parsed.output.data : null;

  return Array.from({ length: count }, (_, i) => {
    const mr = data?.[`m${i}`]?.mergeRequest;

    if (!mr) return null;

    return {
      additions: mr.diffStatsSummary?.additions ?? 0,
      deletions: mr.diffStatsSummary?.deletions ?? 0,
      approved: !!mr.approved,
      approvedBy: mr.approvedBy?.nodes.map((n) => n.name) ?? [],
    };
  });
}

function review(mr: GitlabMergeRequest, stats: GitlabStats | null): PullRequestInfo["review"] {
  if (mr.detailed_merge_status === "requested_changes") return "changesRequested";

  if (stats?.approved && stats.approvedBy.length) return "approved";

  if (mr.detailed_merge_status === "not_approved") return "required";

  return null;
}

function mergeable(mr: GitlabMergeRequest): PullRequestInfo["mergeable"] {
  if (mr.has_conflicts || mr.detailed_merge_status === "conflict" || mr.detailed_merge_status === "need_rebase") return "conflicting";

  return mr.detailed_merge_status === "mergeable" ? "mergeable" : "unknown";
}

/** A merge request as a live folder item, in the authored or the review section. */
export function mapGitlab(mr: GitlabMergeRequest, section: PullRequestSection, stats: GitlabStats | null = null): LiveItem {
  const repo = projectOf(mr);
  const pipeline = mr.head_pipeline;

  return {
    id: `gitlab:${mr.project_id}!${mr.iid}`,
    source: "gitlab",
    url: mr.web_url,
    title: mr.title,
    subtitle: `${repo} !${mr.iid}`,
    icon: null,
    updatedAt: Date.parse(mr.updated_at) || 0,
    section,
    pr: {
      number: mr.iid,
      repo,
      author: mr.author.name,
      authorAvatar: mr.author.avatar_url ?? null,
      draft: !!(mr.draft ?? mr.work_in_progress),
      headRef: mr.source_branch,
      baseRef: mr.target_branch,
      review: review(mr, stats),
      mergeable: mergeable(mr),
      checks: pipeline ? [{ name: "Pipeline", state: lookup(PIPELINE_STATES, pipeline.status) ?? "neutral", url: pipeline.web_url }] : [],
      comments: mr.user_notes_count,
      unresolvedThreads: mr.blocking_discussions_resolved === false ? 1 : 0,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      changedFiles: Number.parseInt(mr.changes_count ?? "", 10) || 0,
      ...(stats?.approvedBy.length ? { approvedBy: stats.approvedBy } : undefined),
    },
  };
}

/** The authored list and the review list as one, a merge request in both shown once, as the person's own. */
export function mergeGitlabLists(authored: GitlabMergeRequest[], review: GitlabMergeRequest[]): { mr: GitlabMergeRequest; section: PullRequestSection }[] {
  const seen = new Set(authored.map((mr) => mr.id));

  return [
    ...authored.map((mr) => ({ mr, section: "authored" as const })),
    ...review.flatMap((mr) => (seen.has(mr.id) ? [] : [{ mr, section: "review" as const }])),
  ];
}

/** What became of a merge request that left the lists: merged, closed, or reviewed (still open, no longer waiting). */
export function gitlabGone(mr: Pick<GitlabMergeRequest, "state">, section: PullRequestSection | undefined): CompletionState | null {
  if (mr.state === "merged") return "merged";

  if (mr.state === "closed") return "closed";

  return section === "review" ? "reviewed" : null;
}

/** The project id and merge request number in an item's id ("gitlab:42!7"). */
export function gitlabIds(itemId: string): { project: number; iid: number } | null {
  const match = /^gitlab:(\d+)!(\d+)$/.exec(itemId);

  return match ? { project: Number(match[1]), iid: Number(match[2]) } : null;
}
