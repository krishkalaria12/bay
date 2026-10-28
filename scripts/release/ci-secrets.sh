#!/usr/bin/env bash
# Puts the release signing material into the repository's Actions secrets, for .github/workflows/release.yml's sign
# job (docs/releasing.md › CI). Run once, and again when a certificate, profile or key changes.
#
#   scripts/release/ci-secrets.sh [<folder>]     default ~/Documents/bay-developer-id
#
# From the folder: developer-id.key and developerID_application.cer (packed into a .p12 with a new random password),
# Bay_Developer_ID.provisionprofile and AuthKey_<id>.p8. NOTARY_KEY_ID and NOTARY_ISSUER come from scripts/.notary.env,
# the Sparkle key from the login keychain (generate_keys -x, account SPARKLE_ACCOUNT, default bay).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
repo="krishkalaria12/bay"
folder="${1:-$HOME/Documents/bay-developer-id}"
die() { echo "error: $*" >&2; exit 1; }
for file in developer-id.key developerID_application.cer Bay_Developer_ID.provisionprofile; do
  [ -f "$folder/$file" ] || die "no $folder/$file"
done
[ -f "$root/scripts/.notary.env" ] || die "no scripts/.notary.env"
. "$root/scripts/.notary.env"
[ -f "${NOTARY_KEY:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER:-}" ] || die "scripts/.notary.env needs NOTARY_KEY, NOTARY_KEY_ID and NOTARY_ISSUER"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
password="$(openssl rand -hex 24)"
openssl x509 -inform DER -in "$folder/developerID_application.cer" -out "$work/cert.pem" 2>/dev/null \
  || cp "$folder/developerID_application.cer" "$work/cert.pem"
openssl x509 -in "$work/cert.pem" -noout -subject | grep -q 'GP328GJT66' || die "the certificate isn't the GP328GJT66 Developer ID"
# -legacy: macOS's security only reads PKCS#12 with the old ciphers (OpenSSL 3's default isn't).
legacy=()
openssl pkcs12 -help 2>&1 | grep -q -- -legacy && legacy=(-legacy)
PW="$password" openssl pkcs12 -export ${legacy[@]+"${legacy[@]}"} -inkey "$folder/developer-id.key" -in "$work/cert.pem" \
  -name "Developer ID Application" -passout env:PW -out "$work/identity.p12"
"$root/apps/browser/macos/Pods/Sparkle/bin/generate_keys" --account "${SPARKLE_ACCOUNT:-bay}" -x "$work/sparkle-key" >/dev/null
[ -s "$work/sparkle-key" ] || die "couldn't export the Sparkle key"

set_secret() { gh secret set "$1" -R "$repo" --body "$2" >/dev/null && echo "set $1"; }
set_secret MACOS_CERTIFICATE_P12 "$(base64 -i "$work/identity.p12")"
set_secret MACOS_CERTIFICATE_PASSWORD "$password"
set_secret MACOS_PROVISIONING_PROFILE "$(base64 -i "$folder/Bay_Developer_ID.provisionprofile")"
set_secret SPARKLE_ED_PRIVATE_KEY "$(cat "$work/sparkle-key")"
set_secret NOTARY_KEY_P8 "$(base64 -i "$NOTARY_KEY")"
set_secret NOTARY_KEY_ID "$NOTARY_KEY_ID"
set_secret NOTARY_ISSUER "$NOTARY_ISSUER"
