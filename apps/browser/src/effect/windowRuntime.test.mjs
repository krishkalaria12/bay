import assert from "node:assert/strict";
import { test } from "node:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AuthorityStore } from "./ports/store.ts";
import { makeWindowRuntime } from "./windowRuntime.ts";
import { MediaService } from "../components/media/service.ts";
import { Persistence } from "../lib/persistenceService.ts";
import { createBrowserStore } from "../store/browserStore.ts";
import { createLocalBrowserReadSource } from "../store/read.ts";

function viewSource() {
  const store = createBrowserStore();
  store.getState().hydrate({});
  const windowId = store.getState().createWindow();
  const projection = createLocalBrowserReadSource(store);
  const listeners = new Set();

  return {
    windowId,
    listeners,
    source: {
      getState: projection.getState,
      subscribe(listener) {
        listeners.add(listener);
        const stop = projection.subscribe(listener);

        return () => {
          listeners.delete(listener);
          stop();
        };
      },
    },
  };
}

test("a window runtime has view services without application authority or persistence", async () => {
  const { source, windowId } = viewSource();
  const runtime = makeWindowRuntime(source, windowId);

  try {
    const context = await runtime.context();

    assert.ok(Option.isNone(Context.getOption(context, AuthorityStore)));
    assert.ok(Option.isNone(Context.getOption(context, Persistence)));
    assert.equal("createWindow" in source.getState(), false, "the source is a projection, without reducers");
    assert.ok(await runtime.runPromise(MediaService));
  } finally {
    await runtime.dispose();
  }
});

test("closing one window stops its view subscriptions without stopping another window", async () => {
  const first = viewSource();
  const second = viewSource();
  const firstRuntime = makeWindowRuntime(first.source, first.windowId);
  const secondRuntime = makeWindowRuntime(second.source, second.windowId);
  const startMedia = Effect.flatMap(MediaService, (media) => media.start);

  try {
    await firstRuntime.runPromise(startMedia);
    await secondRuntime.runPromise(startMedia);
    assert.ok(first.listeners.size > 0);
    assert.ok(second.listeners.size > 0);

    await firstRuntime.dispose();
    assert.equal(first.listeners.size, 0);
    assert.ok(second.listeners.size > 0);
    assert.ok(await secondRuntime.runPromise(MediaService));
  } finally {
    await firstRuntime.dispose();
    await secondRuntime.dispose();
  }

  assert.equal(second.listeners.size, 0);
});
