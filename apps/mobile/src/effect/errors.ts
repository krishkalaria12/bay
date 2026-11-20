// The failures every mobile service shares. A service's own failures live beside the code that raises them; these
// name the operation that failed, the resource it was doing it to, and the cause behind it.
import { TaggedError } from "effect/Data";

/** What was being done, and which resource it was done to. */
export type Operation = {
  readonly name: string;
  readonly resource?: string;
};

/** A native call that could not be made at all: the module is missing, or the platform refused the request. */
export class NativeUnavailable extends TaggedError("NativeUnavailable")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The work stopped before it finished: a closed scope, a dismissed prompt, a replaced document. */
export class Cancelled extends TaggedError("Cancelled")<{
  readonly operation: Operation;
}> {}

/** The bytes came back, but they weren't what the caller expected them to be. */
export class DecodeError extends TaggedError("DecodeError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}
