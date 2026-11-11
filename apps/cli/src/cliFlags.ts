// The flags several bay commands share: where Bay is, how long to wait, and the switches.
import { Flag } from "effect/cli";

/** A boolean flag that never takes the next word as its value: `--json 'code'` is the flag, then the code. */
export const toggle = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withOptionalValue("true"), Flag.withDefault(false), Flag.withDescription(description));

/** --data-dir: Bay's data folder. */
export const dataDirFlag = Flag.String("data-dir").pipe(
  Flag.withDescription("Bay's data folder (else $BAY_DATA_DIR, else the installed Bay's)"),
  Flag.optional,
);

/** --port: a plain DevTools server on 127.0.0.1. */
export const portFlag = Flag.Int("port").pipe(
  Flag.filter(
    (port) => port >= 1 && port <= 65535,
    () => "--port must be an integer between 1 and 65535",
  ),
  Flag.withDescription("a plain DevTools server's port on 127.0.0.1"),
  Flag.optional,
);

/** --ws: a DevTools browser WebSocket URL. */
export const wsFlag = Flag.String("ws").pipe(Flag.withDescription("a ws://host:port/devtools/browser/<id> URL"), Flag.optional);

/** A number of seconds: finite, and not negative. */
export const secondsFlag = (name: string, fallback: number, description: string) =>
  Flag.Finite(name).pipe(
    Flag.filter(
      (seconds) => seconds >= 0,
      () => `--${name} must be a finite, nonnegative number`,
    ),
    Flag.withDefault(fallback),
    Flag.withDescription(description),
  );
