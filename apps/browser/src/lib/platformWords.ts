import { platformOS } from "@bay/platform";

// What the UI calls things that differ by system. Linux's file manager has no one name, so it goes unnamed.
const DESKTOP = {
  thisComputer: "this computer",
  thisComputerTitle: "This Computer",
  eachComputer: "each computer",
  yourComputers: "your computers",
  yourOtherComputer: "your other computer",
  desktopApps: "desktop apps",
  optionKey: "Alt",
  optionShift: "Alt+Shift",
  yourOtherComputers: "your other computers",
  yourComputer: "your computer",
};

const WORDS = {
  macos: {
    osName: "macOS",
    thisComputer: "this Mac",
    thisComputerTitle: "This Mac",
    eachComputer: "each Mac",
    yourComputers: "your Macs",
    yourOtherComputer: "your other Mac",
    desktopApps: "Mac apps",
    fileManager: "Finder",
    revealTitle: "Show in Finder",
    revealSyncFolderTitle: "Show Sync Folder in Finder",
    openFolderTitle: "Open in Finder",
    optionKey: "Option",
    optionShift: "⌥⇧",
    unlockMethod: "Touch ID or your login password",
    systemSettings: "System Settings",
    secretStore: "the Keychain",
    yourOtherComputers: "your other Macs",
    yourComputer: "your Mac",
  },
  windows: {
    ...DESKTOP,
    osName: "Windows",
    fileManager: "File Explorer",
    revealTitle: "Show in File Explorer",
    revealSyncFolderTitle: "Show Sync Folder in File Explorer",
    openFolderTitle: "Open in File Explorer",
    unlockMethod: "Windows Hello or your login password",
    systemSettings: "Settings",
    secretStore: "Windows Credential Manager",
  },
  linux: {
    ...DESKTOP,
    osName: "Linux",
    fileManager: "your file manager",
    revealTitle: "Show in Folder",
    revealSyncFolderTitle: "Show Sync Folder",
    openFolderTitle: "Open Folder",
    unlockMethod: "your login password",
    systemSettings: "system settings",
    secretStore: "your desktop keyring",
  },
};

export const platformWords = WORDS[platformOS];
