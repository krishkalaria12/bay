import { hasNativeModule } from "@bay/platform";

/** Library and Easels need the canvas and image files: BayEasel, native on macOS, the host's on the desktop web hosts. */
export const libraryAvailable = () => hasNativeModule("BayEasel");
