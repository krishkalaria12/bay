// The app's documents: the files it keeps beside the browser. A read and a write are immediate; a save is the
// asynchronous one, and the port keeps track of the saves still in flight so an owner can wait for the disk before
// it lets go of whatever the write was protecting.
import { readDocument, saveDocument, writeDocument } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Operation } from "../errors";

export class DocumentError extends TaggedError("DocumentError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

export class Documents extends Context.Service<
  Documents,
  {
    /** Reads a document. It is null when there isn't one. */
    readonly read: (name: string) => Effect.Effect<string | null, DocumentError>;
    /** Writes a document now. It has landed when this returns. */
    readonly write: (name: string, contents: string) => Effect.Effect<void, DocumentError>;
    /** Writes a document in the background. `settled` waits for it. */
    readonly save: (name: string, contents: string) => Effect.Effect<void, DocumentError>;
    /** Waits for the saves still in flight to land. */
    readonly settled: Effect.Effect<void>;
  }
>()("bay/Documents") {
  static readonly layer = Layer.effect(
    Documents,
    Effect.sync(() => {
      const pending = new Set<Promise<void>>();

      const save = (name: string, contents: string) =>
        Effect.tryPromise({
          try: () => {
            const landing = saveDocument(name, contents);
            pending.add(landing);
            landing.then(
              () => pending.delete(landing),
              () => pending.delete(landing),
            );

            return landing;
          },
          catch: (cause) => new DocumentError({ operation: { name: "document.save", resource: name }, cause }),
        });

      return Documents.of({
        read: (name) =>
          Effect.try({
            try: () => readDocument(name),
            catch: (cause) => new DocumentError({ operation: { name: "document.read", resource: name }, cause }),
          }),
        write: (name, contents) =>
          Effect.try({
            try: () => writeDocument(name, contents),
            catch: (cause) => new DocumentError({ operation: { name: "document.write", resource: name }, cause }),
          }),
        save,
        // A save can start while an earlier one is still landing, so it waits until none is left.
        settled: Effect.suspend(() =>
          Effect.promise(async () => {
            while (pending.size > 0) await Promise.allSettled(pending);
          }),
        ),
      });
    }),
  );
}
