import type { EngineInput } from "@bay/core";
import type { Settings } from "../store/settings";
import type { UserSettingsPatch } from "./settingsCommands";
import { dispatchBrowserCommand } from "./commands";

export const updateSettings = (patch: UserSettingsPatch) => dispatchBrowserCommand({ method: "updateSettings", patch });
export const setTabLayout = (layout: Settings["tabLayout"]) => dispatchBrowserCommand({ method: "setTabLayout", layout });
export const setSearchEngine = (id: string) => dispatchBrowserCommand({ method: "setSearchEngine", id });
export const addCustomEngine = (input: EngineInput) => dispatchBrowserCommand({ method: "addCustomEngine", input });
export const updateCustomEngine = (id: string, input: EngineInput) => dispatchBrowserCommand({ method: "updateCustomEngine", id, input });
export const removeCustomEngine = (id: string) => dispatchBrowserCommand({ method: "removeCustomEngine", id });
