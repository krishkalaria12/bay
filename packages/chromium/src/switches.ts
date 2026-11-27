import * as v from "valibot";
import { Cef } from "./native";

// Remote kill switches: Bay's signed feed (https://baybrowser.in/switches.json), checked and matched to this platform
// and release by bay-switches (packages/rust/bay-switches) on every desktop. The app fetches the feed and keeps the
// last one accepted (apps/browser/src/lib/killSwitches.ts).

const ActiveSwitchSchema = v.object({ id: v.string(), feature: v.string(), reason: v.string(), until: v.optional(v.number()) });

const SwitchCheckSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), issued: v.number(), switches: v.array(ActiveSwitchSchema) }),
  v.object({ ok: v.literal(false), error: v.picklist(["signature", "format", "stale"]) }),
]);

export type ActiveSwitch = v.InferOutput<typeof ActiveSwitchSchema>;

export type SwitchCheck = v.InferOutput<typeof SwitchCheckSchema>;

/** What in `feed` applies here; `lastIssued` is the issue time of the feed kept, 0 for none. Null without the native check. */
export async function checkSwitches(feed: string, signature: string, lastIssued: number): Promise<SwitchCheck | null> {
  const text = await Cef.checkSwitches?.(feed, signature, lastIssued);

  if (text === undefined) return null;
  const parsed = v.safeParse(SwitchCheckSchema, JSON.parse(text));

  return parsed.success ? parsed.output : { ok: false, error: "format" };
}
