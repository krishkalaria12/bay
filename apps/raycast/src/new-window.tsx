import { closeMainWindow, showToast, Toast } from "@raycast/api";
import { newWindow } from "./bay";

export default async function NewWindow() {
  try {
    await closeMainWindow();
    await newWindow();
  } catch (failure) {
    await showToast({ style: Toast.Style.Failure, title: "Couldn't open a window", message: String(failure) });
  }
}
