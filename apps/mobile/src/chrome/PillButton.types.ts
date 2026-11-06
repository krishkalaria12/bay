export interface PillButtonProps {
  testID: string;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  /** Less side padding, for rows (Android; iOS sizes the glass capsule to its label). */
  compact?: boolean;
}
