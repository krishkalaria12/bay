import { dispatchBrowserCommand } from "./commands";
import type { UserCreateSpaceOptions, UserSpacePatch } from "./spaceCommands";

export const createSpace = (options: UserCreateSpaceOptions) => dispatchBrowserCommand({ method: "createSpace", options });
export const updateSpace = (spaceId: string, patch: UserSpacePatch) => dispatchBrowserCommand({ method: "updateSpace", spaceId, patch });
export const deleteSpace = (spaceId: string) => dispatchBrowserCommand({ method: "deleteSpace", spaceId });
export const setDefaultSpace = (spaceId: string) => dispatchBrowserCommand({ method: "setDefaultSpace", spaceId });
export const reorderSpaces = (spaceIds: string[]) => dispatchBrowserCommand({ method: "reorderSpaces", spaceIds });
