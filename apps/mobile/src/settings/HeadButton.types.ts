export interface HeadButtonProps {
  testID: string;
  /** × on the index, ‹ on a page. */
  kind: "close" | "back";
  label: string;
  onPress: () => void;
}
