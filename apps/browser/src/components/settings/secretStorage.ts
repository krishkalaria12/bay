import type { SecretStorageKind } from "@bay/nncore";

type PlatformOS = (typeof import("@bay/platform"))["platformOS"];

// Where Autofill says card numbers are kept.
const CARD_STORE: Record<PlatformOS, string> = {
  macos: "your macOS Keychain",
  windows: "Windows Credential Manager",
  linux: "your desktop keyring",
};
// Where saved passwords live and what holds their key.
const PASSWORD_STORAGE: Record<PlatformOS, string> = {
  macos: "Saved on this Mac, separately for each space, and encrypted with a key in your Keychain.",
  windows: "Saved on this PC, separately for each space, and encrypted with a key Windows protects for your account.",
  linux: "Saved on this computer, separately for each space, and encrypted with a key in your desktop keyring.",
};

export const cardStoreName = (os: PlatformOS) => CARD_STORE[os];
export const passwordStorageDescription = (os: PlatformOS) => PASSWORD_STORAGE[os];

/** Linux falls back to a fixed key, which every Chromium build shares, when no keyring answers. */
export function secretStorageWarning(kind: SecretStorageKind | null): { title: string; description: string } | null {
  if (kind === "basic")
    return {
      title: "Passwords aren't protected by a keyring",
      description:
        "Bay couldn't reach GNOME Keyring, KWallet or another Secret Service, or was started with --password-store=basic. Saved passwords, cookies and card numbers use a fixed key that any app on this computer can read. Start a keyring and reopen Bay; what you save after that uses the keyring.",
    };
  if (kind === "unavailable")
    return {
      title: "Passwords can't be encrypted right now",
      description: "Bay has no key for saved passwords, cookies and card numbers. Unlock your keyring and reopen Bay.",
    };
  return null;
}
