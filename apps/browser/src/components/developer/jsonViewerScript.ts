// Developer Mode's JSON viewer (Arc installed the JSON Formatter extension; Bay needs none), run in the page by
// evaluate (in its main world, with `post` to answer and to message the app as "devMode": devMode.ts ›
// onDeveloperMessage). Only on a JSON document (Chrome shows one as a <pre>): it's drawn as a tree that folds,
// with Raw to see the original text and a click on a key to copy its path. The viewer is in a closed shadow root the
// page's CSS can't reach; the original <pre> is kept, hidden, for Raw. No template literals or backticks inside:
// this file's string is one.
export const JSON_VIEWER_SCRIPT = String.raw`
const KEY = Symbol.for("bay.jsonViewer");
// Chrome draws JSON as a <pre>, with its own Pretty-print control beside it in newer versions.
const pre = document.body ? document.body.querySelector(":scope > pre") : null;
const chromeExtras = document.body ? [...document.body.children].filter((child) => child !== pre) : [];
if (document[KEY] || !/json/i.test(document.contentType || "") || !pre) {
  post("result", JSON.stringify(!!document[KEY]));
  return;
}
const raw = pre.textContent || "";
// Past a few megabytes the tree would take too long to draw: the raw text stays.
if (raw.length > 4000000) {
  post("result", "false");
  return;
}
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  post("result", "false");
  return;
}
document[KEY] = true;
const send = (message) => post("devMode", JSON.stringify(message));
const dark = matchMedia("(prefers-color-scheme: dark)").matches;

const host = document.createElement("bay-json");
host.style.cssText = "all: initial; display: block;";
const shadow = host.attachShadow({ mode: "closed" });
shadow.innerHTML =
  "<style>" +
  ":host { all: initial; }" +
  ".bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 6px; align-items: center; padding: 8px 14px; font: 12px/16px -apple-system, system-ui, sans-serif; background: " + (dark ? "#1e1e20" : "#f6f6f7") + "; border-bottom: 1px solid " + (dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)") + "; color: " + (dark ? "#ddd" : "#333") + "; }" +
  ".bar .info { flex: 1; opacity: 0.6; }" +
  "button { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid " + (dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)") + "; background: " + (dark ? "#2c2c2e" : "#fff") + "; color: inherit; cursor: default; }" +
  "button.on { background: " + (dark ? "#3a3a3c" : "#e8e8ea") + "; }" +
  // Its own background, so its colours never sit on a page painted for the other appearance.
  ".tree { min-height: 100vh; box-sizing: border-box; padding: 10px 14px 40px; font: 12.5px/19px ui-monospace, Menlo, monospace; background: " + (dark ? "#161618" : "#ffffff") + "; color: " + (dark ? "#e6e6e6" : "#1d1d1f") + "; white-space: pre-wrap; word-break: break-word; }" +
  ".row { padding-left: 16px; }" +
  ".fold { display: inline-block; width: 14px; margin-left: -14px; text-align: center; opacity: 0.55; user-select: none; }" +
  ".fold:hover { opacity: 1; }" +
  ".closed > .kids { display: none; }" +
  ".closed > .summary { display: inline; }" +
  ".summary { display: none; opacity: 0.55; }" +
  ".key { color: " + (dark ? "#9cdcfe" : "#a31515") + "; }" +
  ".key:hover { text-decoration: underline; }" +
  ".string { color: " + (dark ? "#ce9178" : "#0b7a0b") + "; }" +
  ".number { color: " + (dark ? "#b5cea8" : "#1750eb") + "; }" +
  ".boolean, .null { color: " + (dark ? "#569cd6" : "#9b2393") + "; }" +
  ".punct { opacity: 0.6; }" +
  "a { color: inherit; }" +
  "</style>" +
  "<div class='bar'><span class='info'></span><button class='collapse'>Collapse All</button><button class='expand'>Expand All</button><button class='raw'>Raw</button></div>" +
  "<div class='tree'></div>";
const $ = (s) => shadow.querySelector(s);
const tree = $(".tree");
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const IDENT = /^[A-Za-z_$][\w$]*$/;
const pathOf = (parent, key) => (typeof key === "number" ? parent + "[" + key + "]" : IDENT.test(key) ? parent + "." + key : parent + "[" + JSON.stringify(key) + "]");

const value = (v) => {
  if (v === null) return el("span", "null", "null");
  if (typeof v === "string") {
    const text = JSON.stringify(v);
    if (/^https?:\/\/\S+$/.test(v)) {
      const span = el("span", "string");
      const link = el("a", "", text);
      link.href = v;
      span.appendChild(link);
      return span;
    }
    return el("span", "string", text);
  }
  return el("span", typeof v, String(v));
};

// A node: its key (clicking it copies its path), and its value; objects and arrays fold. Deep trees start folded past
// the third level, so a big response opens fast and readable.
const node = (key, v, path, depth, last) => {
  const row = el("div", "row");
  if (key !== null) {
    const k = el("span", "key", typeof key === "number" ? String(key) : JSON.stringify(key));
    k.title = "Copy path: " + path;
    k.addEventListener("click", () => send({ type: "copyJsonPath", text: path }));
    row.appendChild(k);
    row.appendChild(el("span", "punct", ": "));
  }
  const comma = last ? "" : ",";
  if (v && typeof v === "object") {
    const isArray = Array.isArray(v);
    const entries = isArray ? v.map((x, i) => [i, x]) : Object.keys(v).map((k) => [k, v[k]]);
    if (!entries.length) {
      row.appendChild(el("span", "punct", (isArray ? "[]" : "{}") + comma));
      return row;
    }
    const fold = el("span", "fold", "▾");
    row.insertBefore(fold, row.firstChild);
    row.appendChild(el("span", "punct", isArray ? "[" : "{"));
    row.appendChild(el("span", "summary", " " + entries.length + (isArray ? (entries.length === 1 ? " item " : " items ") : entries.length === 1 ? " key " : " keys ")));
    const kids = el("div", "kids");
    entries.forEach(([k, x], i) => kids.appendChild(node(k, x, pathOf(path, k), depth + 1, i === entries.length - 1)));
    row.appendChild(kids);
    row.appendChild(el("span", "punct", (isArray ? "]" : "}") + comma));
    const toggle = () => {
      row.classList.toggle("closed");
      fold.textContent = row.classList.contains("closed") ? "▸" : "▾";
    };
    fold.addEventListener("click", toggle);
    if (depth >= 3) toggle();
    return row;
  }
  row.appendChild(value(v));
  row.appendChild(el("span", "punct", comma));
  return row;
};

tree.appendChild(node(null, data, "$", 0, true));
$(".info").textContent = (Array.isArray(data) ? data.length + " items" : data && typeof data === "object" ? Object.keys(data).length + " keys" : typeof data) + " · " + (raw.length > 1024 ? Math.round(raw.length / 1024) + " KB" : raw.length + " bytes");
const setAll = (closed) => {
  for (const row of shadow.querySelectorAll(".row")) {
    const fold = row.querySelector(":scope > .fold");
    if (!fold) continue;
    row.classList.toggle("closed", closed);
    fold.textContent = closed ? "▸" : "▾";
  }
  // The top stays open: folding everything shows its keys.
  const top = tree.firstElementChild;
  if (closed && top) {
    top.classList.remove("closed");
    const fold = top.querySelector(":scope > .fold");
    if (fold) fold.textContent = "▾";
  }
};
$(".collapse").addEventListener("click", () => setAll(true));
$(".expand").addEventListener("click", () => setAll(false));
const rawButton = $(".raw");
rawButton.addEventListener("click", () => {
  const showRaw = !rawButton.classList.contains("on");
  rawButton.classList.toggle("on", showRaw);
  tree.style.display = showRaw ? "none" : "";
  pre.style.display = showRaw ? "" : "none";
});
pre.style.display = "none";
for (const child of chromeExtras) child.style.display = "none";
document.body.style.margin = "0";
document.body.insertBefore(host, document.body.firstChild);
// Raw shows below the bar, as Chrome draws it.
host.after(pre);
post("result", "true");
`;
