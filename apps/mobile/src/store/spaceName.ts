import type { Translate } from "@/i18n";

import { PERSONAL_SPACE } from "./model";
import type { BrowserSpace } from "./types";

/**
 * A space's name as the user sees it. The first space is saved as "Personal" before anyone names it; while it keeps
 * that name, it shows in the current language. Names the user gave stay as they are.
 */
export function spaceName(space: BrowserSpace, t: Translate): string {
  return space.id === PERSONAL_SPACE.id && space.name === PERSONAL_SPACE.name ? t("space.personal") : space.name;
}
