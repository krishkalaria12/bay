import {
  CONFLUENCE_CQL,
  DRIVE_QUERY,
  mapBitbucket,
  mapConfluence,
  mapDrive,
  mapNotion,
  NOTION_SEARCH_BODY,
  type BitbucketPR,
  type BitbucketStatuses,
  type ConfluenceSearch,
  type DriveFiles,
  type NotionSearch,
  type NotionUsers,
} from "./documents";
import {
  detailIds,
  detailNodes,
  GITHUB_DETAILS_QUERY,
  GITHUB_QUERY,
  GITHUB_STATE_QUERY,
  GITHUB_VARIABLES,
  githubAnswer,
  githubBody,
  githubHeaders,
  mapGithub,
  withDetails,
  type DetailsResponse,
  type GithubResponse,
} from "./github";
import { DETAILS_PAGE } from "./constants";
import { accountToken } from "./connectionService";
import { basic, endpoints, getSecret, notionHeaders, request } from "./net";
import { live } from "./activityStore";
import { LiveError, type CompletionState, type LiveFolder, type LiveItem, type LiveSourceId } from "./types";

export type LiveSource = {
  id: LiveSourceId;
  name: string;
  kind: LiveFolder["kind"];
  site: string;
  fetch(folder: LiveFolder): Promise<LiveItem[]>;
  resolveGone?(items: LiveItem[]): Promise<Record<string, CompletionState>>;
};

async function secret(source: LiveSourceId): Promise<string> {
  const value = await getSecret(source);

  if (!value) throw new LiveError(live().accounts[source] ? "signedOut" : "notConfigured", "Not signed in");

  return value;
}

// MARK: GitHub

async function githubGraphql<T>(token: string, query: string, variables: Record<string, string | string[]> = {}): Promise<T> {
  const json = await request<T & { errors?: { type?: string; message: string }[] }>(endpoints.githubGraphql, {
    method: "POST",
    headers: githubHeaders(token),
    body: githubBody(query, variables),
  });

  const answer = githubAnswer(json);

  if (!answer.ok) throw answer.error;

  return answer.data;
}

const github: LiveSource = {
  id: "github",
  name: "GitHub",
  kind: "pullRequests",
  site: "https://github.com",
  async fetch(folder) {
    const token = await secret("github");
    const json = await githubGraphql<GithubResponse>(token, GITHUB_QUERY, GITHUB_VARIABLES);
    const ids = detailIds(json, folder.filters);
    const pages = Array.from({ length: Math.ceil(ids.length / DETAILS_PAGE) }, (_, i) => ids.slice(i * DETAILS_PAGE, (i + 1) * DETAILS_PAGE));
    const page = async (ids: string[]) => detailNodes(ids, await githubGraphql<DetailsResponse>(token, GITHUB_DETAILS_QUERY, { ids }));

    // Every page or none (a partial result would read as PRs gone); a page is small, so a failure is retried once.
    const retry = (ids: string[]) => (cause: unknown) =>
      cause instanceof LiveError && (cause.kind === "other" || cause.kind === "network") ? page(ids) : Promise.reject(cause);

    const details = await Promise.all(pages.map((ids) => page(ids).catch(retry(ids))));

    return mapGithub(withDetails(json, details.flat()), folder.filters);
  },
  async resolveGone(items) {
    const prs = items.filter((it) => it.source === "github");

    if (!prs.length) return {};
    const token = await secret("github");
    const ids = prs.map((it) => it.id.slice("github:".length));
    const json = await githubGraphql<{ data?: { nodes: ({ id: string; state: string } | null)[] } }>(token, GITHUB_STATE_QUERY, { ids });
    const out: Record<string, CompletionState> = {};

    for (const n of json.data?.nodes ?? []) {
      if (!n) continue;
      const item = prs.find((it) => it.id === `github:${n.id}`);

      if (!item) continue;

      if (n.state === "MERGED") out[item.id] = "merged";
      else if (n.state === "CLOSED") out[item.id] = "closed";
      // Still open but no longer awaiting you: you finished your review.
      else if (item.section === "review" || item.section === "team") out[item.id] = "reviewed";
    }

    return out;
  },
};

// MARK: Bitbucket Cloud

const bitbucketAuth = async () => basic(live().config.bitbucketUser, await secret("bitbucket"));

const bitbucket: LiveSource = {
  id: "bitbucket",
  name: "Bitbucket",
  kind: "pullRequests",
  site: "https://bitbucket.org",
  async fetch(folder) {
    if (!folder.filters.authored) return [];
    const auth = await bitbucketAuth();
    const me = live().accounts.bitbucket;

    if (!me) throw new LiveError("signedOut", "Not signed in");

    const page = await request<{ values: BitbucketPR[] }>(`${endpoints.bitbucket}/pullrequests/${encodeURIComponent(me.login)}?state=OPEN&pagelen=50`, {
      headers: { Authorization: auth },
    });

    return Promise.all(
      page.values.map(async (pr) => {
        const repo = pr.destination.repository.full_name;

        const statuses = await request<BitbucketStatuses>(`${endpoints.bitbucket}/repositories/${repo}/pullrequests/${pr.id}/statuses?pagelen=50`, {
          headers: { Authorization: auth },
        }).catch(() => null);

        return mapBitbucket(pr, statuses);
      }),
    );
  },
};

// MARK: Notion

const notion: LiveSource = {
  id: "notion",
  name: "Notion",
  kind: "documents",
  site: "https://www.notion.so",
  async fetch() {
    const token = await secret("notion");

    const [pages, users] = await Promise.all([
      request<NotionSearch>(`${endpoints.notion}/search`, { method: "POST", headers: notionHeaders(token), body: JSON.stringify(NOTION_SEARCH_BODY) }),
      request<NotionUsers>(`${endpoints.notion}/users?page_size=100`, { headers: notionHeaders(token) }).catch(() => null),
    ]);

    return mapNotion(pages, users, live().accounts.notion?.name ?? null);
  },
};

// MARK: Confluence

const confluence: LiveSource = {
  id: "confluence",
  name: "Confluence",
  kind: "documents",
  site: "https://www.atlassian.com",
  async fetch() {
    const { confluenceSite, confluenceEmail } = live().config;

    if (!confluenceSite) throw new LiveError("notConfigured", "No Confluence site");
    const auth = basic(confluenceEmail, await secret("confluence"));
    const url = `${endpoints.confluence(confluenceSite)}/wiki/rest/api/content/search?limit=30&expand=space,history.lastUpdated&cql=${encodeURIComponent(CONFLUENCE_CQL)}`;

    return mapConfluence(await request<ConfluenceSearch>(url, { headers: { Authorization: auth } }), confluenceSite);
  },
};

// MARK: Google Drive

const gdrive: LiveSource = {
  id: "gdrive",
  name: "Google Drive",
  kind: "documents",
  site: "https://drive.google.com",
  async fetch() {
    // The service owns the token behind it: it is refreshed when it is due, and a disconnected account has none.
    const token = await accountToken("gdrive");

    const query = Object.entries(DRIVE_QUERY)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

    return mapDrive(await request<DriveFiles>(`${endpoints.drive}/files?${query}`, { headers: { Authorization: `Bearer ${token}` } }));
  },
};

export const SOURCES: Record<LiveSourceId, LiveSource> = { github, bitbucket, notion, confluence, gdrive };
