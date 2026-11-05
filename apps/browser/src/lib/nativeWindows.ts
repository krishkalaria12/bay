/** Keeps desired windows separate from acknowledged native windows. An open
 * that finishes after its window was removed is followed by a cleanup close.
 */
export function createNativeWindowReconciler<Options>({
  open,
  close,
  setTitle,
  focus,
  openFailed,
  closed,
  report,
}: {
  open(id: string, options: Options): void | Promise<void>;
  close(id: string): void | Promise<void>;
  setTitle(id: string, title: string): void | Promise<void>;
  focus(id: string): void | Promise<void>;
  openFailed(id: string): void;
  closed(id: string, options: Options): void;
  report(operation: string, id: string, error: unknown): void;
}) {
  type Wanted = { id: string; title: string; options: Options };
  type Entry = {
    status: "opening" | "open" | "closing";
    options: Options;
    title: string;
    wantedFocus: boolean;
    cancelled: boolean;
    nativeClosed: boolean;
    released: boolean;
  };
  let disposed = false;
  const pending = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const entries = new Map<string, Entry>();
  const failed = new Set<string>();
  let wanted = new Map<string, Wanted>();
  let focusedId: string | null = null;

  const release = (id: string, entry: Entry) => {
    if (entry.released) return;
    entry.released = true;
    try {
      closed(id, entry.options);
    } catch (error) {
      report("release", id, error);
    }
  };
  // Dispatch immediately, preserving macOS call order and void-returning hosts.
  const invoke = (run: () => void | Promise<void>) => {
    try {
      return track(Promise.resolve(run()));
    } catch (error) {
      return track(Promise.reject(error));
    }
  };
  const finishClose = (id: string, entry: Entry) => {
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    release(id, entry);
    // A close event is delivered before native.ts removes its store window.
    // Reconcile after that listener finishes. This also handles a desired ID
    // restored while the old close was awaiting its acknowledgement.
    void Promise.resolve().then(reconcile);
  };
  const beginClose = (id: string, entry: Entry) => {
    if (entry.status === "closing") return;
    entry.status = "closing";
    void invoke(() => close(id)).then(
      () => finishClose(id, entry),
      (error) => {
        // Keep uncertain failures recorded instead of resending a close on the
        // next unrelated store update. A real native close event can finish it.
        report("close", id, error);
      },
    );
  };
  const updateTitle = (id: string, entry: Entry) => {
    const next = wanted.get(id);
    if (!next || next.title === entry.title) return;
    entry.title = next.title;
    void invoke(() => setTitle(id, next.title)).catch((error) => report("title", id, error));
  };

  function reconcile() {
    if (disposed) return;
    for (const window of wanted.values()) {
      const { id } = window;
      if (!wanted.has(id) || failed.has(id)) continue;
      const existing = entries.get(id);
      if (existing) {
        if (existing.status === "open") updateTitle(id, existing);
        continue;
      }
      const entry: Entry = {
        status: "opening",
        options: window.options,
        title: window.title,
        wantedFocus: id === focusedId,
        cancelled: false,
        nativeClosed: false,
        released: false,
      };
      entries.set(id, entry);
      void invoke(() => open(id, window.options)).then(
        () => {
          // Even a close event can precede completion of an in-flight create.
          // One acknowledged cleanup close prevents a late page resurrection,
          // and keeps its private profile alive until creation has settled.
          if (entry.nativeClosed || entry.cancelled || !wanted.has(id)) return beginClose(id, entry);
          entry.status = "open";
          updateTitle(id, entry);
          if (entry.wantedFocus && focusedId && focusedId !== id && entries.get(focusedId)?.status === "open") {
            const current = focusedId;
            void invoke(() => focus(current)).catch((error) => report("focus", current, error));
          }
        },
        (error) => {
          report("open", id, error);
          failed.add(id);
          // Remove the invisible canonical window before another update can try
          // again. Close also cleans up a possibly partial native creation.
          try {
            openFailed(id);
          } catch (failure) {
            report("reconcile", id, failure);
          }
          beginClose(id, entry);
        },
      );
    }
    for (const [id, entry] of entries) {
      if (wanted.has(id)) continue;
      entry.cancelled = true;
      if (entry.status === "open") beginClose(id, entry);
    }
  }

  return {
    async flush() {
      while (pending.size) await Promise.allSettled(pending);
    },
    dispose() {
      disposed = true;
    },
    sync(windows: Wanted[], focused: string | null) {
      if (disposed) return;
      wanted = new Map(windows.map((window) => [window.id, window]));
      focusedId = focused;
      for (const id of failed) if (!wanted.has(id)) failed.delete(id);
      reconcile();
    },
    nativeClosed(id: string) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.nativeClosed = true;
      // A pending create retains its profile until its reply and cleanup close.
      if (entry.status !== "opening") finishClose(id, entry);
    },
  };
}
