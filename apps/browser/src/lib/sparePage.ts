import { warmSpareRenderer } from "@bay/chromium";
import { engineProfile, isIncognitoSpace } from "../store/model";
import { switchedOff } from "./killSwitches";

// The spare page (G13): when the address bar or a new tab opens, the person is about to open a page, so the engine
// starts its renderer now (nn_spare_warmup). Chrome keeps at most one per profile, hands it to the next page that fits
// and drops it under memory pressure; the engine skips it on battery saver. Not for private windows, and not more than
// once every few seconds per profile.

export const WARM_EVERY_MS = 10_000;

const lastWarm = new Map<string, number>();

export function warmSparePage(spaceId: string, warm = warmSpareRenderer, now = Date.now()): boolean {
  if (isIncognitoSpace(spaceId) || switchedOff("sparePage")) return false;
  const profile = engineProfile(spaceId);
  const last = lastWarm.get(profile);

  if (last !== undefined && now - last < WARM_EVERY_MS) return false;
  lastWarm.set(profile, now);
  void warm(profile).catch(() => {});

  return true;
}
