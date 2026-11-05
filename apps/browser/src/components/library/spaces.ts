import type { BrowserState } from "../../store/browserStore";
import { isIncognitoSpace } from "../../store/model";

/** The spaces the Library lists: every one but a private window's. */
export const publicSpaceIds = (s: Pick<BrowserState, "spaces" | "spaceOrder">) =>
  s.spaceOrder.filter((id) => {
    const space = s.spaces[id];
    return !!space && !isIncognitoSpace(space.id) && !isIncognitoSpace(space.profileId ?? "");
  });
