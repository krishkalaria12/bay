import { NativeEventEmitter, requireNativeComponent } from "react-native";
import type { ComponentType } from "react";
import NativeBayWindows from "./specs/NativeBayWindows";
import { bindWindowsModule, validateWindowsBridge, type WindowsBridge } from "./nativeBridge";
export type { EventSubscription } from "./nativeBridge";

let bridge: WindowsBridge | undefined;
let emitter: NativeEventEmitter | undefined;
const modules = new Map<string, unknown>();
const views = new Map<string, ComponentType<object>>();

function getBridge(): WindowsBridge | null {
  if (bridge) return bridge;
  if (!NativeBayWindows) return null;
  const constants = NativeBayWindows.getConstants();
  const candidate = {
    ...constants,
    invoke: NativeBayWindows.invoke.bind(NativeBayWindows),
    invokeSync: NativeBayWindows.invokeSync.bind(NativeBayWindows),
  };
  validateWindowsBridge(candidate);
  bridge = candidate;
  return bridge;
}

export function requireOptionalNativeModule<T = unknown>(name: string): T | null {
  if (modules.has(name)) return modules.get(name) as T;
  const native = getBridge();
  if (!native) return null;
  const module = bindWindowsModule<T>(native, name, (event, listener) => {
    emitter ??= new NativeEventEmitter(NativeBayWindows!);
    return emitter.addListener(event, listener);
  });
  if (module) modules.set(name, module);
  return module;
}

export function requireNativeModule<T = unknown>(name: string): T {
  const module = requireOptionalNativeModule<T>(name);
  if (!module) throw new Error(`Required Windows module ${name} is unavailable. Rebuild Bay with its native Windows implementation.`);
  return module;
}

export function requireOptionalNativeViewManager<P extends object>(name: string): ComponentType<P> | null {
  if (!getBridge()?.views.includes(name)) return null;
  if (!views.has(name)) views.set(name, requireNativeComponent(name));
  return views.get(name) as ComponentType<P>;
}

export function requireNativeViewManager<P extends object>(name: string): ComponentType<P> {
  const view = requireOptionalNativeViewManager<P>(name);
  if (!view) throw new Error(`Required Windows view ${name} is unavailable. Rebuild Bay with its native Windows component.`);
  return view;
}
