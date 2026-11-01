export type IconName =
  | "archive"
  | "search"
  | "settings"
  | "tabs"
  | "more"
  | "fill"
  | "close"
  | "add"
  | "private"
  | "lock"
  | "shield"
  | "up"
  | "down"
  | "play"
  | "pause"
  | "back"
  | "forward"
  | "reload"
  | "reader"
  | "find"
  | "inspect"
  | "hide"
  | "markdown"
  | "share"
  | "pin"
  | "unpin"
  | "link"
  | "copy"
  | "history"
  | "delete"
  | "desktop"
  | "offline"
  | "error";

export interface IconProps {
  name: IconName;
  color: string;
  size?: number;
}
