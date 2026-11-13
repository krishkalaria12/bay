// The two hooks the app's components use to run work on the runtime. They replace the generation counters, the mounted
// refs and the cancelled flags the components used to keep by hand: a hook owns the work it started and lets it go
// when the component does.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { useCallback, useEffect, useRef, useState } from "react";
import { readCommandExit, type CommandResult } from "./commands.ts";
import type { Operation } from "./errors.ts";
import { mobileRuntime, type AppServices } from "./runtime.ts";

/** The name a hook reports a failure under. */
const OPERATION: Operation = { name: "command" };

/** What a hook gives a component: a way to run work, and the last answer. */
export type Command<A, E = unknown> = {
  /** Runs a program. The answer arrives in `result`. */
  readonly run: (program: Effect.Effect<A, E, AppServices>) => void;
  /** The last answer, or null while there isn't one. */
  readonly result: CommandResult<A> | null;
};

/**
 * Runs a program in a scope and reads how it ended. The scope owns the work: closing it interrupts the program and
 * runs the finalizers the program registered.
 */
const runInScope = <A>(program: Effect.Effect<A, unknown, AppServices>, scope: Scope.Closeable, onResult: (result: CommandResult<A>) => void): void => {
  const workflow = Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(Scope.provide(scope)(program), scope);
    const exit = yield* Fiber.await(fiber);

    return yield* readCommandExit(OPERATION, exit);
  });

  void mobileRuntime.runPromise(workflow).then(onResult, (cause: unknown) => {
    console.error("A command could not run", cause);
  });
};

/**
 * Runs work that belongs to the component. The work is interrupted when the component unmounts, and a result that
 * arrives after that is dropped.
 */
export function useCommand<A = void, E = unknown>(): Command<A, E> {
  const [result, setResult] = useState<CommandResult<A> | null>(null);
  const scopeRef = useRef<Scope.Closeable | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      // The component is gone: the work it started is over.
      mountedRef.current = false;

      const scope = scopeRef.current;

      scopeRef.current = null;

      if (scope) void Effect.runPromise(Scope.close(scope, Exit.void));
    };
  }, []);

  const run = useCallback((program: Effect.Effect<A, E, AppServices>) => {
    let scope = scopeRef.current;

    if (!scope) {
      scope = Effect.runSync(Scope.make());
      scopeRef.current = scope;
    }

    runInScope(program, scope, (answer) => {
      // A result that arrives after the component unmounted is dropped.
      if (!mountedRef.current) return;

      setResult(answer);
    });
  }, []);

  return { run, result };
}

/** A scope and the key it belongs to. */
type ScopedWork = {
  readonly key: string;
  readonly scope: Scope.Closeable;
};

/**
 * Runs work that belongs to something with a name: a document, a tab, a query. The work is interrupted when the key
 * changes, because the thing it was about is gone, and a result that arrives after that is dropped.
 */
export function useScopedWork<A = void, E = unknown>(key: string): Command<A, E> {
  const [result, setResult] = useState<CommandResult<A> | null>(null);
  const workRef = useRef<ScopedWork | null>(null);

  useEffect(() => {
    const owned = key;

    return () => {
      const current = workRef.current;

      // The scope was already replaced by a newer key, so it is not this cleanup's to close.
      if (!current || current.key !== owned) return;

      workRef.current = null;

      void Effect.runPromise(Scope.close(current.scope, Exit.void));
    };
  }, [key]);

  const run = useCallback(
    (program: Effect.Effect<A, E, AppServices>) => {
      let current = workRef.current;

      if (!current || current.key !== key) {
        const previous = current;

        current = { key, scope: Effect.runSync(Scope.make()) };
        workRef.current = current;

        if (previous) void Effect.runPromise(Scope.close(previous.scope, Exit.void));
      }

      runInScope(program, current.scope, (answer) => {
        // A result that arrives after the key changed is dropped: the scope it belonged to closed.
        if (workRef.current !== current) return;

        setResult(answer);
      });
    },
    [key],
  );

  return { run, result };
}
