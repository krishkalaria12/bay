import * as v from "valibot";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the actual native-to-public event mapping without loading a React
// Native renderer or replacing the component with a parallel implementation.
const source = ts.createSourceFile("ChromiumView.tsx", readFileSync(new URL("./ChromiumView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);

const declaration = source.statements.find(
  (node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === "unwrap"),
);

assert.ok(declaration);

const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const unwrap = new Function("toAppUrl", `${code}\nreturn unwrap;`)((url) => url.replace(/^bay:\/\//, "app://"));

test("mount and discard recovery preserve both native browser ids", () => {
  assert.deepEqual(unwrap.onReady({ browserId: 41, tabId: 52 }), [41, 52]);
  assert.deepEqual(unwrap.onReady({ browserId: 41 }), [41, 0]);
  assert.deepEqual(unwrap.onDiscarded({ url: "bay://settings" }), ["app://settings"]);
});

test("page and picture-in-picture activation reasons reach the public handler", () => {
  for (const reason of ["page", "pictureInPicture"]) assert.deepEqual(unwrap.onActivateRequest({ reason }), [{ reason }]);
});

// Run the component's real mount effect against controllable native replies.
const nativeSource = ts.createSourceFile(
  "NativeWebView.web.tsx",
  readFileSync(new URL("./NativeWebView.web.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

let mountEffect;

function findMountEffect(node) {
  if (!mountEffect && ts.isCallExpression(node) && node.expression.getText(nativeSource) === "useEffect") mountEffect = node.arguments[0];
  ts.forEachChild(node, findMountEffect);
}

findMountEffect(nativeSource);

assert.ok(mountEffect);

const effectCode = ts.transpileModule(`const mountEffect = ${mountEffect.getText(nativeSource)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function mountHarness() {
  let receive;
  let finishMount;
  const surfaces = [];
  const events = [];
  const pending = { current: Promise.resolve() };

  const scope = {
    activeTag: { current: 0 },
    latestSerialized: { current: "{}" },
    firstProps: { current: "{}" },
    latest: { current: Object.fromEntries(["onReady", "onDiscarded"].map((event) => [event, (payload) => events.push([event, payload.nativeEvent])])) },
    setSurfaceId: (surface) => surfaces.push(surface),
    setError: (error) => assert.equal(error, null),
    subscribeNativeEvent: (_module, _event, handler) => {
      receive = handler;

      return { remove() {} };
    },
    invokeNative: (_module, method) =>
      method === "mount"
        ? new Promise((resolve) => {
            finishMount = resolve;
          })
        : Promise.resolve(),
    pending,
    windowId: "window-1",
  };

  const effect = new Function("v", ...Object.keys(scope), `let nextTag = 1; ${effectCode}\nreturn mountEffect;`)(v, ...Object.values(scope));
  effect();
  await Promise.resolve();
  await Promise.resolve();

  return {
    surfaces,
    events,
    send(event, payload) {
      receive({ tag: 1, event, payload });
    },
    async reply(discarded = false) {
      finishMount({ surfaceId: "original", browserId: 41, chromeTabId: 52, discarded });
      await pending.current;
    },
  };
}

test("a replacement surface received before the mount reply stays attached", async () => {
  const mounted = await mountHarness();
  mounted.send("__surfaceChanged", { surfaceId: "replacement" });
  await mounted.reply();
  assert.equal(mounted.surfaces.at(-1), "replacement");
  assert.deepEqual(mounted.events, []);
});

test("native lifecycle events before the mount reply suppress synthetic readiness", async () => {
  for (const event of ["onDiscarded", "onReady"]) {
    const mounted = await mountHarness();
    mounted.send(event, { browserId: 41, tabId: 52 });
    await mounted.reply();
    assert.deepEqual(
      mounted.events.map(([name]) => name),
      [event],
    );
  }
});

test("ordinary mounts report readiness once and discarded mounts wait for wakeup", async () => {
  const mounted = await mountHarness();
  await mounted.reply();
  assert.deepEqual(mounted.events, [["onReady", { browserId: 41, tabId: 52 }]]);
  const discarded = await mountHarness();
  await discarded.reply(true);
  assert.deepEqual(discarded.events, []);
  discarded.send("onReady", { browserId: 41, tabId: 52 });
  assert.equal(discarded.events.length, 1);
});
