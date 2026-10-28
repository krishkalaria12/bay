import { requireNativeViewManager } from "@bay/platform/native";
import type { ComponentType, RefAttributes } from "react";
import type { NativeHandle, NativeProps } from "./WebView";

type NativeView = ComponentType<NativeProps & RefAttributes<NativeHandle>>;

export default requireNativeViewManager<NativeProps>("BayCEF") as unknown as NativeView;

// macOS's WebKit page view (BayWebKit), resolved on first use: other builds never ask for it (hasWebKit()).
let webKit: NativeView | undefined;
export const webKitView = (): NativeView => (webKit ??= requireNativeViewManager<NativeProps>("BayWebKit") as unknown as NativeView);
