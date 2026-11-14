// Keep the adapter entry at .ts, matching nativeViews.ts. Metro resolves source
// extensions in order, so a .web.tsx sibling loses to the default .ts entry.
export { requireNativeViewManager } from "./webNativeViews";
