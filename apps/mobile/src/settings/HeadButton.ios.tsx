import type { JSX } from "react";

import { GlassIconButton } from "@/chrome/GlassIconButton";

import type { HeadButtonProps } from "./HeadButton.types";

/** Settings' round button on the left of its head, in Liquid Glass as Yab's is: × on the index, ‹ on a page. */
export function HeadButton({ testID, kind, label, onPress }: HeadButtonProps): JSX.Element {
  return <GlassIconButton id={testID} label={label} systemImage={kind === "close" ? "xmark" : "chevron.backward"} onPress={onPress} />;
}
