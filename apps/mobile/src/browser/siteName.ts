import { hostOf } from "@bay/core/src/input.ts";

/** A site's name as Bay shows it under its icon or beside its title: the host without "www.". */
export function siteName(url: string): string {
  return hostOf(url).replace(/^www\./, "");
}
