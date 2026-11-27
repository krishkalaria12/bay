import assert from "node:assert/strict";
import { test } from "node:test";
import { gitlabBase, gitlabGone, gitlabIds, gitlabStats, gitlabStatsQuery, mapGitlab, mergeGitlabLists } from "./gitlab.ts";

const mr = (over = {}) => ({
  id: 501,
  iid: 12,
  project_id: 42,
  title: "Cache the runner images",
  state: "opened",
  updated_at: "2026-09-25T07:00:00Z",
  web_url: "https://gitlab.example.com/acme/infra/runners/-/merge_requests/12",
  source_branch: "cache",
  target_branch: "main",
  user_notes_count: 3,
  author: { name: "Octo Dev", avatar_url: "https://gitlab.example.com/a.png" },
  ...over,
});

test("a site as typed becomes its https base", () => {
  assert.equal(gitlabBase(""), "https://gitlab.com");
  assert.equal(gitlabBase("gitlab.example.com/"), "https://gitlab.example.com");
  assert.equal(gitlabBase("https://code.example.com/gitlab"), "https://code.example.com/gitlab");
  assert.equal(gitlabBase("http://gitlab.example.com"), null);
  assert.equal(gitlabBase("https://gitlab.example.com/?x=1"), null);
});

test("a merge request maps to a pull request item, its project from the reference or the address", () => {
  const item = mapGitlab(
    mr({
      references: { full: "acme/infra/runners!12" },
      detailed_merge_status: "not_approved",
      head_pipeline: { status: "failed", web_url: "https://p" },
      changes_count: "1000+",
    }),
    "authored",
  );

  assert.equal(item.id, "gitlab:42!12");
  assert.equal(item.subtitle, "acme/infra/runners !12");
  assert.equal(item.pr.review, "required");
  assert.equal(item.pr.mergeable, "unknown");
  assert.deepEqual(item.pr.checks, [{ name: "Pipeline", state: "failure", url: "https://p" }]);
  assert.equal(item.pr.changedFiles, 1000);
  assert.equal(mapGitlab(mr(), "review").pr.repo, "acme/infra/runners");
  assert.equal(mapGitlab(mr({ has_conflicts: true, work_in_progress: true }), "review").pr.mergeable, "conflicting");
  assert.equal(mapGitlab(mr({ work_in_progress: true }), "review").pr.draft, true);
  assert.deepEqual(mapGitlab(mr({ head_pipeline: { status: "manual", web_url: "" } }), "authored").pr.checks[0].state, "neutral");
});

test("a merge request in both lists shows once, as the person's own", () => {
  const merged = mergeGitlabLists([mr()], [mr(), mr({ id: 502, iid: 13 })]);

  assert.deepEqual(
    merged.map(({ mr, section }) => [mr.iid, section]),
    [
      [12, "authored"],
      [13, "review"],
    ],
  );
});

test("what became of one that left the lists", () => {
  assert.equal(gitlabGone({ state: "merged" }, "authored"), "merged");
  assert.equal(gitlabGone({ state: "closed" }, "review"), "closed");
  assert.equal(gitlabGone({ state: "opened" }, "review"), "reviewed");
  assert.equal(gitlabGone({ state: "opened" }, "authored"), null);
  assert.deepEqual(gitlabIds("gitlab:42!12"), { project: 42, iid: 12 });
  assert.equal(gitlabIds("github:abc"), null);
});

test("GraphQL fills in line counts and who approved, by alias", () => {
  const mrs = [mr({ references: { full: "acme/infra/runners!12" } }), mr({ id: 502, iid: 13, references: { full: 'acme/"odd"!13' } })];
  const query = gitlabStatsQuery(mrs);

  assert.match(query, /m0: project\(fullPath: "acme\/infra\/runners"\) \{ mergeRequest\(iid: "12"\)/);
  assert.match(query, /m1: project\(fullPath: "acme\/\\"odd\\""\)/);

  const stats = gitlabStats(
    {
      data: {
        m0: { mergeRequest: { approved: true, approvedBy: { nodes: [{ name: "Ada" }, { name: "Lin" }] }, diffStatsSummary: { additions: 40, deletions: 2 } } },
        m1: null,
      },
    },
    2,
  );

  assert.deepEqual(stats, [{ additions: 40, deletions: 2, approved: true, approvedBy: ["Ada", "Lin"] }, null]);
  const item = mapGitlab(mrs[0], "authored", stats[0]);
  assert.equal(item.pr.review, "approved");
  assert.deepEqual([item.pr.additions, item.pr.deletions, item.pr.approvedBy], [40, 2, ["Ada", "Lin"]]);
  assert.equal(mapGitlab(mr({ detailed_merge_status: "requested_changes" }), "authored", stats[0]).pr.review, "changesRequested");
  assert.deepEqual(gitlabStats({ errors: [{ message: "nope" }] }, 1), [null]);
});
