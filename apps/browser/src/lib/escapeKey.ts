// RN macOS reports Esc in a text field as the field's cancel command, through onKeyPress, never onKeyDown: a text
// field that handles Esc takes this as its onKeyPress. Keep Escape in its keyDownEvents too, or RN takes the field's
// focus away on Esc (and an onBlur runs before this does).
export const onEscapeKey = (handler: () => void) => (e: { nativeEvent: { key: string } }) => {
  if (e.nativeEvent.key === "Escape") handler();
};
