import { requireNativeViewManager } from "./nativeViews";
import type { ViewProps } from "@bay/platform";
import type { LocalFileDescriptor } from "./localFilesNative";

export { localFiles } from "./localFilesNative";
export type { LocalFileAccess, LocalFileDescriptor, LocalFileEntry, LocalFileListing, LocalFileStatus } from "./localFilesNative";

export type LocalFilesAreaProps = ViewProps & {
  dropEnabled?: boolean;
  rootPath?: string;
  relativePath?: string;
  onFilesDropped?: (event: { nativeEvent: { files: LocalFileDescriptor[] } }) => void;
  onFilesDropError?: (event: { nativeEvent: { message: string } }) => void;
  onDropActive?: (event: { nativeEvent: { active: boolean } }) => void;
  /** A click that did not become a drag, or VoiceOver's press. */
  onActivate?: () => void;
  onContextMenu?: () => void;
};

/** Native NSURL pasteboard dragging works inside Chromium pages and in other apps. */
export const LocalFilesArea = requireNativeViewManager<LocalFilesAreaProps>("BayLocalFiles");
