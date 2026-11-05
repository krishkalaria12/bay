type Selection = (start: number, end: number) => void;
type SelectableInput = { setSelection?: Selection; setSelectionRange?: Selection };

/** Keep the DOM ref intact for focus, measurement and findNodeHandle. */
export function installTextInputSelection(input: SelectableInput | null): void {
  if (input && typeof input.setSelection !== "function" && typeof input.setSelectionRange === "function") {
    input.setSelection = (start, end) => input.setSelectionRange!(start, end);
  }
}
