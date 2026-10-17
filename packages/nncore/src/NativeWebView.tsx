import { requireNativeViewManager } from "@bay/platform/native";
import type { ComponentType, RefAttributes } from "react";
import type { NativeHandle, NativeProps } from "./WebView";
export default requireNativeViewManager<NativeProps>("BayCEF") as unknown as ComponentType<NativeProps & RefAttributes<NativeHandle>>;
