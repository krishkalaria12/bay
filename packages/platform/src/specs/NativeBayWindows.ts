import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

/** JSON values cross the Windows dispatcher; generated contracts retain individual method types. */
export interface Spec extends TurboModule {
  getConstants(): {
    contractVersion: number;
    modules: string[];
    views: string[];
    constantsJSON: string;
  };
  invoke(module: string, method: string, argsJSON: string): Promise<string>;
  invokeSync(module: string, method: string, argsJSON: string): string;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>("BayWindows");
