// Hello Bay: every part of the plugin format in one small script (docs/plugins.md). It runs in a sandboxed page of
// its own; everything it reaches goes through `bay`.

const api = async (path) => {
  const { user, token } = await bay.settings.get();
  const headers = { Accept: "application/vnd.github+json" };

  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await bay.fetch(`https://api.github.com${path.replace("{user}", encodeURIComponent(user))}`, { headers });

  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

  return response.json();
};

async function showRepositories() {
  const repos = await api("/users/{user}/repos?sort=updated&per_page=30");

  await bay.views.set(
    "repos",
    repos.map((repo) => ({ id: String(repo.id), title: repo.name, subtitle: repo.description ?? "", icon: "tray", url: repo.html_url })),
  );
  await bay.toolbar.set("repos", { badge: String(repos.length) });
}

bay.commands.on("copy-title", async ({ tab }) => {
  if (!tab) return;
  const remembered = (await bay.storage.get("pages")) ?? [];

  await bay.storage.set("pages", [{ url: tab.url, title: tab.title }, ...remembered].slice(0, 50));
  await bay.notify(`Remembered “${tab.title}”`);
});

bay.commands.on("open-profile", async () => {
  const { user } = await bay.settings.get();

  await bay.tabs.open(`https://github.com/${encodeURIComponent(user)}`);
});

bay.liveSources.on("starred", async () => {
  const starred = await api("/users/{user}/starred?per_page=30");

  return starred.map((repo) => ({
    id: String(repo.id),
    url: repo.html_url,
    title: repo.full_name,
    subtitle: repo.description ?? "",
    icon: repo.owner?.avatar_url,
    updatedAt: Date.parse(repo.pushed_at) || undefined,
  }));
});

bay.links.decide(async ({ url, spaces }) => {
  const { workLinks } = await bay.settings.get();

  return workLinks && url.startsWith("https://github.com/") && spaces.some((space) => space.name === "Work") ? { space: "Work" } : null;
});

bay.settings.onChange(() => void showRepositories().catch(() => {}));

showRepositories().catch((error) => console.error(error));
