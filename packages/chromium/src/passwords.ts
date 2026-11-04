import { Cef, valueOr } from "./native";

export type SavedPassword = { origin: string; username: string; created: number; modified: number };

export const listPasswords = async (profile: string): Promise<SavedPassword[]> => valueOr(await Cef.listPasswords(profile), { passwords: [] }).passwords;
export const unlockPasswords = async (profile: string): Promise<boolean> => valueOr(await Cef.unlockPasswords(profile), { unlocked: false }).unlocked;
export const getPassword = async (profile: string, origin: string, username: string) =>
  valueOr(await Cef.getPassword(profile, origin, username), { password: null }).password;
export const savePassword = async (profile: string, origin: string, username: string, password: string) =>
  valueOr(await Cef.savePassword(profile, origin, username, password), null) !== null;
export const updatePassword = async (profile: string, origin: string, username: string, changes: { username?: string; password?: string }) =>
  valueOr(await Cef.updatePassword(profile, origin, username, changes.username ?? null, changes.password ?? null), null) !== null;
export const deletePassword = async (profile: string, origin: string, username: string) =>
  valueOr(await Cef.deletePassword(profile, origin, username), null) !== null;
export const setNeverSavePasswords = async (profile: string, origin: string, never: boolean) => {
  if (!never) valueOr(await Cef.allowSavingPasswords(profile, origin), null);
};
export const getNeverSavePasswordOrigins = async (profile: string) => valueOr(await Cef.getNeverSavePasswordOrigins(profile), { origins: [] }).origins;
/**
 * The key protecting saved passwords, cookies and card numbers on Linux: the desktop keyring, the fixed key every
 * Chromium build shares ("basic"), or none. null on hosts that don't report it; macOS and Windows always use the OS.
 */
export type SecretStorageKind = "keyring" | "basic" | "unavailable";
export const secretStorage = async (): Promise<SecretStorageKind | null> => (await Cef.secretStorage?.().catch(() => null)) ?? null;
export type PasswordExportStatus = "succeeded" | "cancelled" | "writeFailed" | "reauthFailed" | "inProgress";
/** Chrome's export: asks where to save, then for Touch ID or the login password, then writes a CSV. */
export const exportPasswords = async (profile: string): Promise<{ status: PasswordExportStatus; path?: string }> =>
  valueOr(await Cef.exportPasswords(profile), { status: "writeFailed" as PasswordExportStatus });
export const getPasswordAutofill = (profile = "") => Cef.getPasswordAutofill(profile);
export const setPasswordAutofill = (enabled: boolean, profile = "") => Cef.setPasswordAutofill(profile, enabled);
