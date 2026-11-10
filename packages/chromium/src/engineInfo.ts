import * as v from "valibot";
import type { JsonObject } from "./json";
import { Cef } from "./native";

type EngineCallArgs = JsonObject;

const EngineErrorSchema = v.object({ error: v.string() });

/** An engine event's payload: the profile that produced it, plus whatever the topic's subscribers read. */
export type EngineEventPayload = JsonObject & { profile: string };

// Calls into //chrome/browser/bay, the engine's own code over Chrome's stores (history, favicons, closed
// tabs). JSON in, JSON out; the native side allows only the calls it lists (NNEngineBridge.mm).
export async function engineCall<T>(name: string, profile: string, args?: EngineCallArgs): Promise<T> {
  const result: unknown = JSON.parse(await Cef.engineCall(name, profile, args ? JSON.stringify(args) : null));

  if (v.is(EngineErrorSchema, result)) throw new Error(`${name}: ${result.error}`);

  // SAFETY: each named engine call replies with exactly the JSON shape its TypeScript caller declares for it.
  return result as T;
}

// The engine's change events ("<domain>.<what>"); `profile` is the app's engine profile ("" for the default one).
// Filter before parsing so subscribers only decode the payloads they use. Omit `topic` to receive every event.
export const onEngineEvent = (listener: (topic: string, payload: EngineEventPayload) => void, topic?: string) =>
  Cef.addListener("onEngineEvent", (e) => {
    if (topic !== undefined && e.topic !== topic) return;

    // SAFETY: the engine emits every event's payload as JSON, with the profile the event came from.
    listener(e.topic, JSON.parse(e.payload) as EngineEventPayload);
  });
