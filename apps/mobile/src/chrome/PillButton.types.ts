export interface PillButtonProps {
  testID: string;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  /** Kept visible but can't be pressed. */
  disabled?: boolean;
  /** Less side padding, for rows (Android; iOS sizes the glass capsule to its label). */
  compact?: boolean;
}
