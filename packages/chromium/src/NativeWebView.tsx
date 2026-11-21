import { checked } from "./json.ts";
import { requireNativeViewManager } from "@bay/platform/native";
import type { ComponentType, RefAttributes } from "react";
import type { NativeHandle, NativeProps } from "./ChromiumView";

type NativeView = ComponentType<NativeProps & RefAttributes<NativeHandle>>;

export default checked<NativeView>(requireNativeViewManager<NativeProps>("BayCEF"));

// macOS's WebKit page view (BayWebKit), resolved on first use: other builds never ask for it (hasWebKit()).
let webKit: NativeView | undefined;

export const webKitView = (): NativeView => (webKit ??= checked<NativeView>(requireNativeViewManager<NativeProps>("BayWebKit")));
