import { describe, expect, it } from "bun:test";
import { buildNamespace, compileCode, formatValue, NO_PAGE_TAB } from "../src/runner.ts";
import { NoPageTab, Session, Tab } from "../src/browser.ts";

describe("exec evaluation", () => {
  it.each([
    ["({ a: 1 })", { a: 1 }],
    ["[1, 2]", [1, 2]],
    ["const value: number = 2; value", 2],
    ["await Promise.resolve({\n a: 1\n})", { a: 1 }],
    ["[1, 2].map(value => {\n return value * 2;\n})", [2, 4]],
    ["const value = 3;\nvalue // trailing comment", 3],
    ["return 7", 7],
    ["const value = 7;", undefined],
  ])("returns the completion value of %s", async (source, value) => {
    // SAFETY: every it.each row pairs a TypeScript source string with its completion value; source is always that string.
    const actual: unknown = await compileCode(source as string, "example.ts")({});

    expect(actual).toEqual(value);
  });

  it("uses the last opened tab when no page is visible", async () => {
    const session = new Session({ ws: "ws://localhost", source: "test", explicit: true, active: null });
    const namespace = buildNamespace(session, "example.ts");
    const tab = new Tab(session, "new");
    // SAFETY: namespace.js("42") requests the number 42; the stub returns 42 for any T, and the test awaits it as a number.
    tab.evaluate = async <T>() => 42 as T;
    session.opened.push(tab);
    expect(await namespace.js("42")).toBe(42);
  });

  it("reports no page without an active or opened tab", async () => {
    const session = new Session({ ws: "ws://localhost", source: "test", explicit: true, active: null });
    const namespace = buildNamespace(session, "example.ts");
    await expect(namespace.js("42")).rejects.toThrow(new NoPageTab(NO_PAGE_TAB));
  });

  it("does not print a literal undefined in JSON mode", () => {
    expect(formatValue(undefined, true)).toBeNull();
  });
});
