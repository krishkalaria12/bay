import { decodeSharedCollection, sharedCollectionAppUrl, sharedLinkCount, type SharedItem } from "@bay/core/src/sharedCollection";

const title = document.querySelector<HTMLHeadingElement>("#share-title")!;
const summary = document.querySelector<HTMLParagraphElement>("#share-summary")!;
const state = document.querySelector<HTMLDivElement>("#share-state")!;
const contents = document.querySelector<HTMLDivElement>("#share-contents")!;
const importButton = document.querySelector<HTMLButtonElement>("#share-import")!;
const copyButton = document.querySelector<HTMLButtonElement>("#share-copy")!;
const copyStatus = document.querySelector<HTMLParagraphElement>("#share-copy-status")!;

let appUrl: string | null = null;
let sharedUrl: string | null = null;

function renderItems(items: SharedItem[]): HTMLUListElement {
  const list = document.createElement("ul");

  for (const item of items) {
    const row = document.createElement("li");
    if (item.kind === "folder") {
      row.className = "share-folder";
      const label = document.createElement("p");
      label.className = "share-folder-title";
      label.textContent = item.title || "Untitled folder";
      row.append(label);
      if (item.children.length > 0) {
        row.append(renderItems(item.children));
      } else {
        const empty = document.createElement("p");
        empty.className = "share-folder-empty";
        empty.textContent = "Empty folder";
        row.append(empty);
      }
    } else {
      // The shared codec validates HTTP(S) URLs before anything reaches the DOM.
      const link = document.createElement("a");
      link.className = "share-link";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      const name = document.createElement("span");
      name.className = "share-link-title";
      name.textContent = item.title || item.url;
      const address = document.createElement("span");
      address.className = "share-link-url";
      address.textContent = item.url;
      link.append(name, address);
      row.append(link);
    }
    list.append(row);
  }

  return list;
}

function showCollection(): void {
  appUrl = null;
  sharedUrl = null;
  importButton.disabled = true;
  copyButton.disabled = true;
  copyStatus.textContent = "";
  contents.replaceChildren();
  contents.hidden = true;
  state.hidden = false;
  title.textContent = "A collection of links";
  summary.textContent = "Preview the links here, or save a copy in Bay.";

  const token = window.location.hash.slice(1);
  if (!token) {
    state.textContent = "No collection in this link. Open the complete shared link from the sender, including everything after #.";
    return;
  }

  try {
    const collection = decodeSharedCollection(token);
    const count = sharedLinkCount(collection);
    const tree = renderItems(collection.children);
    const collectionAppUrl = sharedCollectionAppUrl(token);
    title.textContent = collection.title || "Untitled collection";
    const kind = collection.kind === "split" ? "Split View" : collection.kind === "selection" ? "Selection" : "Folder";
    summary.textContent = `${kind} shared from Bay. ${count} ${count === 1 ? "link" : "links"}.`;
    sharedUrl = `${window.location.origin}${window.location.pathname}#${token}`;
    copyButton.disabled = false;

    if (collection.children.length > 0) {
      contents.append(tree);
      contents.hidden = false;
    }
    if (count === 0) {
      state.textContent = "This collection has no links to add. Ask the sender to share a collection with links.";
      return;
    }

    appUrl = collectionAppUrl;
    importButton.disabled = false;
    state.hidden = true;
  } catch {
    state.textContent = "This shared link is invalid or incomplete. Ask the sender for a new link and copy the whole address.";
  }
}

importButton.addEventListener("click", () => {
  if (appUrl) window.location.assign(appUrl);
});

copyButton.addEventListener("click", async () => {
  const url = sharedUrl;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    if (sharedUrl === url) copyStatus.textContent = "Shared link copied.";
  } catch {
    if (sharedUrl === url) copyStatus.textContent = "Could not copy. Copy the full link from your address bar.";
  }
});

window.addEventListener("hashchange", showCollection);
showCollection();
