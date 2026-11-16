// React's commits on the Chrome-hosted desktop, for a trace (packages/platform/src/profiling.ts). React reports each
// commit to a DevTools hook; index.web.ts imports this first, so the renderer finds the hook as it loads. While a trace
// records, a commit becomes a "Bay.react commit" span naming the components that rendered in it, how many of each, and
// how many mounted. Otherwise the hook returns at once. (macOS has perfProbe.ts and js-bench instead.)
import * as v from "valibot";
import { profiling, span } from "@bay/platform/profiling";

type ComponentType = { displayName?: string; name?: string; render?: ComponentType; type?: ComponentType } | string | null | undefined;

type Fiber = {
  tag: number;
  flags: number;
  type: ComponentType;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
};

// What the renderer hands the hook; this hook only keeps it.
type Renderer = { readonly rendererPackageName?: string; readonly version?: string };

type Hook = {
  supportsFiber: boolean;
  renderers: Map<number, Renderer>;
  inject(renderer: Renderer): number;
  onCommitFiberRoot(id: number, root: { current: Fiber }, priority?: number, didError?: boolean): void;
  onCommitFiberUnmount(id: number, fiber: Fiber): void;
  onPostCommitFiberRoot(id: number, root: { current: Fiber }): void;
  checkDCE(fn: () => void): void;
};

// Function, class, forwardRef and memo components (React's work tags); host views are named by them.
const COMPONENTS = new Set([0, 1, 11, 14, 15]);

// React marks a fiber that rendered in this commit.
const PERFORMED_WORK = 1;
const MAX_NAMES = 40;

function nameOf(type: ComponentType): string {
  if (!type) return "Anonymous";

  if (v.is(v.string(), type)) return type;

  return type.displayName || type.name || nameOf(type.render ?? type.type);
}

function walk(root: Fiber, rendered: Map<string, number>) {
  let renders = 0;
  let mounts = 0;
  const stack: Fiber[] = [root];

  while (stack.length) {
    const fiber = stack.pop()!;

    if (COMPONENTS.has(fiber.tag) && (fiber.flags & PERFORMED_WORK || !fiber.alternate)) {
      const name = nameOf(fiber.type);
      rendered.set(name, (rendered.get(name) ?? 0) + 1);
      renders++;

      if (!fiber.alternate) mounts++;
    }

    if (fiber.sibling) stack.push(fiber.sibling);

    // A subtree React bailed out of keeps its previous children: nothing in it rendered.
    if (fiber.child && (!fiber.alternate || fiber.child !== fiber.alternate.child)) stack.push(fiber.child);
  }

  return { renders, mounts };
}

let firstCommit = true;

function onCommit(root: { current: Fiber }) {
  if (firstCommit) {
    firstCommit = false;
    // From navigation start to the document's first frame of UI (a startup trace).
    span("Bay.startup firstCommit", 0);
  }

  if (!profiling()) return;
  const start = performance.now();
  const rendered = new Map<string, number>();
  const { renders, mounts } = walk(root.current, rendered);

  if (!renders) return;

  const components = [...rendered]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NAMES)
    .map(([name, count]) => `${name}:${count}`)
    .join(",");

  // The span is the walk itself, so a report can take it out; the commit's own work is in the samples before it.
  span("Bay.react commit", start, { renders, mounts, components });
}

declare global {
  var __REACT_DEVTOOLS_GLOBAL_HOOK__: Hook | undefined;
}

const existing = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;

if (existing) {
  // React DevTools (the preview in a browser with the extension): keep it, and add to its commits.
  const commit = existing.onCommitFiberRoot.bind(existing);

  existing.onCommitFiberRoot = (id, root, priority, didError) => {
    commit(id, root, priority, didError);
    onCommit(root);
  };
} else {
  let nextId = 1;
  const renderers = new Map<number, Renderer>();

  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject(renderer) {
      const id = nextId++;
      renderers.set(id, renderer);

      return id;
    },
    onCommitFiberRoot: (_id, root) => onCommit(root),
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
}
