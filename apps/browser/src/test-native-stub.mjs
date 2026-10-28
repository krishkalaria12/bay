import { nativeContracts } from "../../../packages/platform/src/nativeContracts.ts";

export const docs = new Map();
export const readDocument = (name) => docs.get(name) ?? null;
export const writeDocument = (name, contents) => docs.set(name, contents);
// Native file access is opt-in for each test. A synced path by itself has no grant.
export const localFileAnswers = {
  inspect: async () => ({ status: "inaccessible" }),
  list: async () => ({ access: { status: "inaccessible" }, entries: [] }),
  open: async () => ({ status: "inaccessible" }),
  reconnect: async () => null,
};
export const localFiles = {
  inspect: (...args) => localFileAnswers.inspect(...args),
  list: (...args) => localFileAnswers.list(...args),
  open: (...args) => localFileAnswers.open(...args),
  reconnect: (...args) => localFileAnswers.reconnect(...args),
};
// saveDocument lands at once, or, while heldSaves.on, when a test runs the queued releases.
export const heldSaves = { on: false, queue: [], error: null };
export const saveDocument = (name, contents) =>
  new Promise((resolve, reject) => {
    const land = () => (heldSaves.error ? reject(heldSaves.error) : (docs.set(name, contents), resolve()));
    if (heldSaves.on) heldSaves.queue.push(land);
    else land();
  });
export const setZoom = () => Promise.resolve();
export const launchEnvironment = () => null;
export const appInfo = { appVersion: "1.0" };
export const systemInfo = () => ({ ...appInfo });
export const calendarAuthorization = () => "notDetermined";
export const requestCalendarAccess = () => Promise.resolve(false);
export const systemCalendars = () => Promise.resolve([]);
export const systemCalendarEvents = () => Promise.resolve([]);
export const calendarChangedListeners = new Set();
export const onCalendarChanged = (listener) => (calendarChangedListeners.add(listener), { remove: () => calendarChangedListeners.delete(listener) });
export const emitCalendarChanged = () => calendarChangedListeners.forEach((listener) => listener());
export const keychainAnswers = {
  get: async () => null,
  set: async () => true,
  delete: async () => true,
};
export const keychainGet = (...args) => keychainAnswers.get(...args);
export const keychainSet = (...args) => keychainAnswers.set(...args);
export const keychainDelete = (...args) => keychainAnswers.delete(...args);
export const easelSharingAnswers = {
  enabled: false,
  identity: async () => ({ id: "a".repeat(32), key: "b".repeat(64) }),
  readRecords: () => docs.get("easel-shares.json") ?? null,
};
export const createEaselShareIdentity = () => easelSharingAnswers.identity();
export const isEaselWebSharingEnabled = () => easelSharingAnswers.enabled;
export const readEaselShareRecords = () => easelSharingAnswers.readRecords();
export const shellDialogAnswers = {
  confirm: async () => ({ confirmed: false, suppressed: false }),
  openTextFile: async () => null,
  prompt: async () => null,
  saveTextFile: async () => null,
};
export const confirm = (...args) => shellDialogAnswers.confirm(...args);
export const openTextFile = (...args) => shellDialogAnswers.openTextFile(...args);
export const prompt = (...args) => shellDialogAnswers.prompt(...args);
export const saveTextFile = (...args) => shellDialogAnswers.saveTextFile(...args);
export const windowEventListeners = new Set();
export const onWindowEvent = (listener) => (windowEventListeners.add(listener), { remove: () => windowEventListeners.delete(listener) });
export const emitWindowEvent = (event) => windowEventListeners.forEach((listener) => listener(event));
export const focusedWindows = [];
export const sidebarMoveUndoCalls = [];
export const setSidebarMoveUndo = (windowId, available, focus = false) => (sidebarMoveUndoCalls.push({ windowId, available, focus }), Promise.resolve());
export const focusWindow = (windowId) => (focusedWindows.push(windowId), Promise.resolve());
export const appEventListeners = new Set();
export const onAppEvent = (listener) => (appEventListeners.add(listener), { remove: () => appEventListeners.delete(listener) });
export const emitAppEvent = (event) => appEventListeners.forEach((listener) => listener(event));
export const pageEventListeners = new Set();
export const onPageEvent = (listener) => (pageEventListeners.add(listener), { remove: () => pageEventListeners.delete(listener) });
export const emitPageEvent = (event) => pageEventListeners.forEach((listener) => listener(event));
export const pageOpenListeners = new Set();
export const onPageOpen = (listener) => (pageOpenListeners.add(listener), { remove: () => pageOpenListeners.delete(listener) });
export const emitPageOpen = (event) => pageOpenListeners.forEach((listener) => listener(event));
export const finishedPageOpens = [];
export const finishPageOpen = (offerId, tabId) => (finishedPageOpens.push({ offerId, tabId }), Promise.resolve());
export const pageEventSource = { replay: [], openReplay: [], error: null, starts: 0, stops: 0 };
export const startPageEvents = () => {
  pageEventSource.starts++;
  pageEventSource.replay.forEach(emitPageEvent);
  pageEventSource.openReplay.forEach(emitPageOpen);
  return pageEventSource.error ? Promise.reject(pageEventSource.error) : Promise.resolve();
};
export const stopPageEvents = () => (pageEventSource.stops++, Promise.resolve());
export const postNotification = () => Promise.resolve(null);
export const removeNotifications = () => Promise.resolve();
export const fetchFavicon = () => Promise.resolve(null);
export const iconTheme = () => Promise.resolve(null);
export const cancelDownload = () => Promise.resolve();
let webKitAvailable = true;
export const hasWebKit = () => webKitAvailable;
export const setWebKitAvailable = (on) => void (webKitAvailable = on);
export const endedWebKitSessions = [];
export const endWebKitPrivateSession = (session) => (endedWebKitSessions.push(session), Promise.resolve());
export const WEBKIT_SITE_SETTINGS = ["camera", "microphone"];
export const getWebKitSiteSettings = () => Promise.resolve({});
export const setWebKitSiteSetting = () => Promise.resolve();
export const renameFile = (path, _name) => Promise.resolve(path);
export const onDownload = () => ({ remove() {} });
export const deletedProfileData = [];
export const profileDataLeft = new Map();
export const deleteProfileData = (profile) => (deletedProfileData.push(profile), Promise.resolve(profileDataLeft.get(profile) ?? []));

/** Validate injected native mocks against the same contracts used by the Windows dispatcher. */
export function assertNativeStub(name, stub, { partial = false } = {}) {
  const contract = nativeContracts.modules[name];
  if (!contract) throw new Error(`Unknown native stub ${name}`);
  if (!stub || typeof stub !== "object") throw new TypeError(`${name} must be an object`);
  for (const [method, spec] of Object.entries(contract.methods)) {
    if (partial && !(method in stub)) continue;
    if (spec.optional && stub[method] == null) continue;
    if (typeof stub[method] !== "function") throw new TypeError(`${name}.${method} must be a function`);
  }
  for (const [key, type] of Object.entries(contract.constants)) {
    if (partial && !(key in stub)) continue;
    if (["number", "string", "boolean"].includes(type) && typeof stub[key] !== type) {
      throw new TypeError(`${name}.${key} must be ${type}`);
    }
  }
  if (!partial && contract.events.length && typeof stub.addListener !== "function") {
    throw new TypeError(`${name}.addListener must be a function`);
  }
  return stub;
}
// expo-modules-core: a test installs native modules on globalThis.nnTestNativeModules.
export const requireOptionalNativeModule = (name) => {
  const stub = globalThis.nnTestNativeModules?.[name] ?? null;
  return stub == null ? null : assertNativeStub(name, stub, { partial: true });
};
export const requireNativeModule = (name) => globalThis.nnTestNativeModules?.[name] ?? {};
export const nativeRandomUUID = (fallback) => fallback();
export const nativeSnapshot = (_module, _method, _args, fallback) => fallback();
// Saved passwords, one store per simulated device (sync tests).
export const passwordStores = new Map();
export const current = { device: null };
const logins = () => passwordStores.get(current.device);
export const savePassword = async (_profile, origin, username, password) => {
  logins().set(`${origin}\n${username}`, { origin: `${origin}/`, url: origin, username, password, created: Date.now() });
  return true;
};
export const deletePassword = async (_profile, origin, username) => (logins().delete(`${origin}\n${username}`), true);
export const readLogins = async () => [...logins().values()];

// Chrome's history (HistoryService), one per simulated device (sync tests) and engine profile: url → { title,
// visits (ms, oldest first) }. Visits Chrome records itself come in through chromeVisit.
export const historyDbs = new Map();
export const chromeHistory = (profile = "", device = current.device) => {
  if (!historyDbs.has(device)) historyDbs.set(device, new Map());
  const dbs = historyDbs.get(device);
  if (!dbs.has(profile)) dbs.set(profile, new Map());
  return dbs.get(profile);
};
const historyListeners = new Set();
const emitHistory = (change) => {
  for (const listener of historyListeners) queueMicrotask(() => listener(change));
};
export const onHistoryChanged = (listener) => (historyListeners.add(listener), { remove: () => historyListeners.delete(listener) });
// Each profile the app asked to watch, in order (Chrome's events reach the app only once it watches).
export const historyWatches = [];
export const watchHistory = async (profile) => (historyWatches.push(profile), { ok: true });
const addVisit = (profile, url, title, at) => {
  const db = chromeHistory(profile);
  const row = db.get(url) ?? { title: "", visits: [] };
  row.visits = [...row.visits, at].sort((a, b) => a - b);
  if (title) row.title = title;
  db.set(url, row);
  emitHistory({ kind: "visit", profile, url, title: row.title, visits: row.visits.length, at });
};
/** A page load Chrome records. */
export const chromeVisit = (profile, url, title, at = Date.now()) => addVisit(profile, url, title, at);
export const queryHistory = async (profile, maxUrls = 5000, maxVisits = 50) =>
  [...chromeHistory(profile)]
    .map(([url, r]) => ({ url, title: r.title, visits: r.visits.length, visitTimes: r.visits.slice(-maxVisits) }))
    .sort((a, b) => b.visitTimes.at(-1) - a.visitTimes.at(-1))
    .slice(0, maxUrls);
export const addHistoryVisits = async (profile, pages, toleranceMs = 1000) => {
  let added = 0;
  for (const page of pages) {
    // One to one: each visit Chrome has accounts for one asked for.
    const have = [...(chromeHistory(profile).get(page.url)?.visits ?? [])];
    for (const at of [...page.visitTimes].sort((a, b) => a - b)) {
      const match = have.findIndex((t) => Math.abs(t - at) <= toleranceMs);
      if (match >= 0) {
        have.splice(match, 1);
        continue;
      }
      addVisit(profile, page.url, chromeHistory(profile).get(page.url)?.title || page.title, at);
      added++;
    }
  }
  return added;
};
export const importHistoryRows = async (profile, rows) => {
  for (const r of rows) if (!chromeHistory(profile).has(r.url)) chromeHistory(profile).set(r.url, { title: r.title, visits: [r.lastVisit] });
};
export const deleteHistoryUrls = async (profile, urls) => {
  for (const url of urls) chromeHistory(profile).delete(url);
  emitHistory({ kind: "deleted", profile, all: false, urls });
};

// Chrome's favicons: none unless a test puts some in.
export const chromeFavicons = new Map();
export const faviconsFor = async (profile, pages) => ({
  pages: new Map(pages.filter((p) => chromeFavicons.has(`${profile}|${p}`)).map((p) => [p, { uri: chromeFavicons.get(`${profile}|${p}`), icon: "" }])),
  icons: new Map(),
});
export const removeLegacyFavicons = () => Promise.resolve();
export const removeDocument = (name) => docs.delete(name);

// Chrome's tab strips (lib/chromeTabs.ts): a test installs a fake engine on globalThis.nnTestTabStrip.
export const chromeWindows = () => Promise.resolve([]);
export const devWindowAction = () => Promise.resolve("");
export const engineInfo = () => Promise.resolve(null);
export const prepareTabTransfer = () => {};
export const releaseTabTransfer = () => {};
export const onTabStripTransaction = (listener) => globalThis.nnTestTabStrip.listen(listener);
export const sendTabStripCommand = (command) => globalThis.nnTestTabStrip.command(command);
export const tabStrips = () => globalThis.nnTestTabStrip.snapshot();

// Chrome's bookmarks (BookmarkModel), one per simulated device and engine profile: nodes by UUID, "bar" and
// "other" the permanent folders. Ops behave as nn_bookmarks_apply's.
export const bookmarkDbs = new Map();
export const chromeBookmarks = (profile = "", device = current.device) => {
  if (!bookmarkDbs.has(device)) bookmarkDbs.set(device, new Map());
  const dbs = bookmarkDbs.get(device);
  if (!dbs.has(profile)) {
    const folder = (id, t) => ({ id, k: "f", t, a: 0, parent: null, children: [] });
    dbs.set(
      profile,
      new Map([
        ["bar", folder("bar", "Bookmarks Bar")],
        ["other", folder("other", "Other Bookmarks")],
      ]),
    );
  }
  return dbs.get(profile);
};
const bookmarkListeners = new Set();
export const onBookmarksChanged = (listener) => (bookmarkListeners.add(listener), { remove: () => bookmarkListeners.delete(listener) });
export const watchBookmarks = async () => ({ ok: true });
const treeOf = (db, id) => {
  const n = db.get(id);
  const key = n.key ? { key: n.key } : {};
  return n.k === "u"
    ? { id: n.id, k: "u", t: n.t, u: n.u, a: n.a, ...key }
    : { id: n.id, k: "f", t: n.t, a: n.a, ...key, c: n.children.map((c) => treeOf(db, c)) };
};
export const bookmarkTree = async (profile) => {
  const db = chromeBookmarks(profile);
  return { bar: treeOf(db, "bar"), other: treeOf(db, "other") };
};
const isAncestor = (db, node, of) => {
  for (let at = of; at; at = db.get(at)?.parent) if (at === node) return true;
  return false;
};
const moveTo = (db, id, parent, index) => {
  const node = db.get(id);
  const old = db.get(node.parent);
  if (old) old.children.splice(old.children.indexOf(id), 1);
  const kids = db.get(parent).children;
  kids.splice(Math.max(0, Math.min(index ?? kids.length, kids.length)), 0, id);
  node.parent = parent;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const applyOp = (db, op) => {
  const node = db.get(op.id);
  const permanent = op.id === "bar" || op.id === "other";
  if (op.op === "remove") {
    if (!node || permanent) return false;
    const drop = (id) => (db.get(id).children ?? []).forEach(drop) || db.delete(id);
    db.get(node.parent).children = db.get(node.parent).children.filter((c) => c !== op.id);
    drop(op.id);
    return true;
  }
  if (op.op === "update") {
    if (!node || permanent) return false;
    if (op.t !== undefined) node.t = op.t;
    if (op.u && node.k === "u") node.u = op.u;
    return true;
  }
  const parent = db.get(op.parent);
  if (!parent || parent.k !== "f") return false;
  if (op.op === "move") {
    if (!node || permanent || isAncestor(db, op.id, op.parent)) return false;
    moveTo(db, op.id, op.parent, op.index);
    return true;
  }
  if (node && op.ifAbsent) return true;
  if (node) {
    if (permanent || isAncestor(db, op.id, op.parent)) return false;
    moveTo(db, op.id, op.parent, op.index);
    node.t = op.t;
    if (op.u && node.k === "u") node.u = op.u;
    return true;
  }
  if (!UUID.test(op.id)) return false;
  if (op.k === "u" && !/^[a-z][a-z0-9+.-]*:/i.test(op.u ?? "")) return "invalid";
  db.set(op.id, { id: op.id, k: op.k, t: op.t, ...(op.k === "u" ? { u: op.u } : { children: [] }), a: op.a, ...(op.key ? { key: op.key } : {}), parent: null });
  moveTo(db, op.id, op.parent, op.index);
  return true;
};
export const bookmarkOpsSent = [];
export const applyBookmarkOps = async (profile, ops) => {
  bookmarkOpsSent.push(...ops);
  const db = chromeBookmarks(profile);
  let applied = 0;
  const invalid = [];
  for (const op of ops) {
    const result = applyOp(db, op);
    if (result === "invalid") invalid.push(op.id);
    else if (result) applied++;
    else break;
  }
  return { applied, skipped: ops.length - applied - invalid.length, invalid };
};
/** An edit something other than the app makes (an extension): Chrome tells the app. */
export const chromeBookmarkEdit = (profile, ops) => {
  const db = chromeBookmarks(profile);
  for (const op of ops) applyOp(db, op);
  for (const listener of bookmarkListeners) queueMicrotask(() => listener(profile));
};

// Extensions: what Chrome answers for a tab's action states and side panel; a test swaps in its own (and late) answers.
export const extensionAnswers = { actionStates: async () => ({}), sidePanelUrl: async () => null };
export const extensionActionStates = (browserId, ids) => extensionAnswers.actionStates(browserId, ids);
export const extensionSidePanelUrl = (browserId, extensionId) => extensionAnswers.sidePanelUrl(browserId, extensionId);

export const copyText = () => {};

export const openWindow = () => Promise.resolve();
// Library assets: a test can replace the importer to simulate an unavailable file.
export const libraryImages = { retain: async (path) => ({ path: `/data/Library Media/${path.split("/").pop()}`, width: 640, height: 480 }) };
export const retainLibraryImage = (path) => libraryImages.retain(path);

export const sidebarKeyboardCalls = [];
export const setSidebarKeyboard = (windowId, active) => (sidebarKeyboardCalls.push({ windowId, active }), Promise.resolve());
// Boosts: what the app last sent the engine.
export const engineBoostCalls = [];
export const setBoosts = (boosts) => (engineBoostCalls.push(boosts), Promise.resolve());

export const tidyNames = null;
