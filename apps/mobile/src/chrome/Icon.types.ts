export type IconName = "archive" | "search" | "settings" | "tabs" | "more" | "fill" | "close" | "add" | "private" | "lock" | "shield";

export interface IconProps {
  name: IconName;
  color: string;
  size?: number;
}
