// Copyright 2026 Bay. Apache-2.0.
//
// Imported cookies: written into the profile's Chrome cookie store through the
// network service's CookieManager (the browser process's own handle). Each one
// is checked as a fresh cookie from the URL that set it
// (CanonicalCookie::CreateSanitizedCookie: public suffixes, sizes, prefixes,
// Secure only from a secure URL). They replace the profile's cookies for the
// same sites: every cookie it has with an imported one's domain and partition
// key goes first, so a site's sign-in is the source's whole, never mixed with
// the profile's own (Google reads a mix as signed out). The profile's device
// bound sessions (DBSC) for those sites end first: one would refresh the
// imported cookies with this profile's key and sign the user out.
//
//   nn_cookies_import  {cookies: [cookie…]} -> {imported: n, rejected: n,
//                                               replaced: n}
//   cookie = {
//     name, value, domain, path          strings; a domain starting with "."
//                                        is a domain cookie, otherwise
//                                        host-only
//     created?, expires?, lastAccess?    ms since the Unix epoch (doubles);
//                                        expires absent or 0: a session cookie
//     secure, httpOnly                   bools
//     sameSite                           "unspecified" | "none" | "lax" |
//                                        "strict" (default unspecified)
//     priority                           "low" | "medium" | "high" (default
//                                        medium)
//     partitionKey?                      {topLevelSite, crossSite: bool}
//                                        (CHIPS), topLevelSite in Chromium's
//                                        own serialization ("https://site");
//                                        "" is unpartitioned
//     sourceScheme                       "unset" | "nonSecure" | "secure"
//     sourcePort                         int, -1 = unspecified
//   }
//
// The cookie is set from <https if secure or sourceScheme is "secure", else
// http>://<domain without its dot>[:<sourcePort>]<path>; that URL's scheme
// and port are what Chrome records as its source.
//
// rejected: Chrome wouldn't accept it fresh, its partition key doesn't parse,
// or it has expired once its expiry is capped from its creation date the way
// Chrome caps any cookie it sets (400 days). replaced: the profile's cookies
// removed for the sites the call carries; the app sends a site's cookies in
// one call (CookieWire.batches), since a later call for the same site would
// remove an earlier one's. Replies once every write has gone through and the
// cookie store has been flushed to disk.
//
// Errors: "private profile" (off the record; nothing is written), "arguments
// too large" (over 4 MB), "too many cookies in one call" (over 1000; the app
// sends ~500 a call), "cookies must be a list".
//
// The arguments carry decrypted cookie values: they're parsed before the call
// returns (the caller zeroes its buffer then), never logged, and the parsed
// copy is zeroed once the cookies are built (nn_sensitive_args.h).

#ifndef CHROME_BROWSER_BAY_NN_COOKIES_H_
#define CHROME_BROWSER_BAY_NN_COOKIES_H_

#include "chrome/browser/bay/nn_engine.h"

NN_ENGINE_CALL(nn_cookies_import);

#endif  // CHROME_BROWSER_BAY_NN_COOKIES_H_
