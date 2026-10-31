import { type TextInput } from "@bay/platform";
import { completeInline, type InlineWrite } from "@bay/shell";
import { nodeTag } from "../../lib/nodeTag";

/** Writes `typed + completion` into the field with the completion selected (macOS: its field editor, which echoes
 *  the change through onChangeText). Null when the field can't take it. */
export function writeInline(input: TextInput | null, typed: string, completion: string): Promise<InlineWrite> | null {
  const tag = nodeTag(input);
  return tag == null ? null : completeInline(tag, typed, completion);
}

/** The field editor selected the completion as it wrote it. */
export function selectInline(_input: TextInput | null, _typed: string, _completion: string) {}
