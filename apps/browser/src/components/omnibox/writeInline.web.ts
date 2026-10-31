import { type TextInput } from "@bay/platform";
import { type InlineWrite } from "@bay/shell";

type Field = HTMLInputElement | HTMLTextAreaElement;

const composing = new WeakSet<Field>();
const watched = new WeakSet<Field>();

function fieldOf(input: TextInput | null): Field | null {
  const node = input as unknown;
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : null;
}

// An IME's marked text isn't the field's yet (macOS's editor checks hasMarkedText).
function watchComposition(field: Field) {
  if (watched.has(field)) return;
  watched.add(field);
  field.addEventListener("compositionstart", () => composing.add(field));
  field.addEventListener("compositionend", () => composing.delete(field));
}

/** The field is React's (Omnibox's value is typed + shown): rather than write it and echo, as macOS's editor does,
 *  accept the completion where the caret is just past what was typed, and select it once rendered (selectInline). */
export function writeInline(input: TextInput | null, typed: string, completion: string): Promise<InlineWrite> | null {
  const field = fieldOf(input);
  if (!field) return null;
  watchComposition(field);
  // Clearing a completion needs no caret: deleting it, the field still shows it until React renders typed alone.
  const accepted =
    !completion ||
    (document.activeElement === field &&
      !composing.has(field) &&
      field.value.startsWith(typed) &&
      field.selectionStart === typed.length &&
      field.selectionEnd === field.value.length);
  return Promise.resolve(accepted ? 1 : 0);
}

export function selectInline(input: TextInput | null, typed: string, completion: string) {
  const field = fieldOf(input);
  if (!field || document.activeElement !== field || field.value !== typed + completion) return;
  field.setSelectionRange(typed.length, field.value.length, "forward");
}
