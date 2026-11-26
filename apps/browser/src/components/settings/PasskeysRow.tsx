import { requestWebKitPasskeyAccess, webKitPasskeyAccess, type PasskeyAccess } from "@bay/chromium";
import { openExternalURL } from "@bay/desktop";
import { useEffect, useState } from "react";
import { Button, Row } from "./controls";
import { SETTINGS } from "./definitions";

const PASSKEY_STATUS: Record<PasskeyAccess["status"], string> = {
  entitlementRequired: "Waiting for Apple to grant Bay its browser passkey entitlement. Sign in another way meanwhile.",
  deviceNotConfigured: "Passkeys aren't set up on this Mac. Set up iCloud Keychain or another passkey app in System Settings.",
  notDetermined: "Allow Bay to use the passkeys saved on this Mac, from the Passwords app and other passkey apps, in Chromium and WebKit pages.",
  denied: "Off. Turn Bay on in System Settings › Privacy & Security › Passkeys Access for Web Browsers.",
  authorized: "Websites can sign in with the passkeys saved on this Mac, in Chromium and WebKit pages.",
};

/** The Mac's passkeys (iCloud Keychain and passkey apps) for Bay's pages: Apple's browser entitlement, then the
 *  person's permission. Settings › Passwords and Settings › Engines; nothing on a build without WebKit (Windows, Linux). */
export function PasskeysRow() {
  const [access, setAccess] = useState<PasskeyAccess | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    void webKitPasskeyAccess()
      .then((a) => live && setAccess(a))
      .catch(() => {});

    return () => {
      live = false;
    };
  }, []);

  if (!access) return null;

  const ask = async () => {
    setAsking(true);
    const next = await requestWebKitPasskeyAccess().catch(() => null);

    if (next) setAccess(next);
    setAsking(false);
  };

  return (
    <Row settingId={SETTINGS.passkeys.id} title={SETTINGS.passkeys.title} description={PASSKEY_STATUS[access.status]}>
      {access.status === "notDetermined" && <Button title="Allow Passkeys…" disabled={asking} onPress={() => void ask()} />}
      {access.status === "denied" && (
        <Button title="Open System Settings" onPress={() => void openExternalURL("x-apple.systempreferences:com.apple.preference.security")} />
      )}
    </Row>
  );
}
