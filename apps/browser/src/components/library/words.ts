import { isMac } from "@bay/platform";

export const thisComputer = isMac ? "this Mac" : "this computer";
export const revealTitle = isMac ? "Show in Finder" : "Show in Folder";
