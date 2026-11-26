import { closeMainWindow, showToast, Toast, type LaunchProps } from "@raycast/api";
import { newTab } from "./bay";
import { addressFor } from "./parse";

// A new tab in Bay's front window: the New Tab page, or the address given.
export default async function NewTab({ arguments: { url = "" } }: LaunchProps<{ arguments: { url?: string } }>) {
  const address = url.trim() ? addressFor(url) : "";

  if (address === null) {
    await showToast({ style: Toast.Style.Failure, title: "Not an address", message: "Type an address, or leave it empty for the New Tab page." });

    return;
  }

  try {
    await closeMainWindow();
    await newTab(address);
  } catch (failure) {
    await showToast({ style: Toast.Style.Failure, title: "Couldn't open a tab", message: String(failure) });
  }
}
