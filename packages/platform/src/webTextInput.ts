import * as v from "valibot";

type Selection = (start: number, end: number) => void;

type SelectableInput = { setSelection?: Selection; setSelectionRange?: Selection };

/** Keep the DOM ref intact for focus, measurement and findNodeHandle. */
export function installTextInputSelection(input: SelectableInput | null): void {
  if (input && !v.is(v.function_(), input.setSelection) && v.is(v.function_(), input.setSelectionRange)) {
    input.setSelection = (start, end) => input.setSelectionRange!(start, end);
  }
}
