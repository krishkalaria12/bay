export interface PillButtonProps {
  testID: string;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  /** Kept visible but can't be pressed. */
  disabled?: boolean;
  /** A tighter capsule, for rows: less side padding on Android, the small control size on iOS. */
  compact?: boolean;
}
