import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export type UserScriptsFolder = { token?: string } & (
  | { state: "empty" | "busy" | "pending"; generation?: number }
  | { state: "absent"; generation: number; path: string }
  | { state: "invalid"; generation?: number; error: string; path?: string }
  | { state: "ready"; generation: number; path: string }
);

type UserScriptsNative = {
  watch(on: boolean): void;
  read(): Promise<UserScriptsFolder>;
  readStatus(): Promise<string | null>;
  writeStatus(json: string): Promise<void>;
  addListener(name: "onChange", listener: () => void): EventSubscription;
};

const Native = requireOptionalNativeModule<UserScriptsNative>("BayUserScripts");
export const userScriptsAvailable = () => Native !== null;
export const watchUserScripts = (on: boolean) => Native?.watch(on);
export const readUserScripts = (): Promise<UserScriptsFolder> => Native?.read() ?? Promise.resolve({ state: "empty" });
export const readUserScriptsStatus = (): Promise<string | null> => Native?.readStatus() ?? Promise.resolve(null);
export const writeUserScriptsStatus = (json: string): Promise<void> => Native?.writeStatus(json) ?? Promise.resolve();
export const onUserScriptsChange = (listener: () => void) => Native?.addListener("onChange", listener) ?? { remove() {} };
