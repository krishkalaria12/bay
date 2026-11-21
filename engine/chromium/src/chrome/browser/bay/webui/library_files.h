// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_LIBRARY_FILES_H_
#define CHROME_BROWSER_BAY_WEBUI_LIBRARY_FILES_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/memory/ref_counted_memory.h"
#include "base/memory/scoped_refptr.h"
#include "base/values.h"

namespace bay {

// The files behind Library, Easels and Capture on the desktop hosts. The page
// decodes and normalizes images (Blink, in its renderer), so this only moves
// PNG bytes: <user data>/Library Media holds what the user keeps, and its
// cache folder the captures not saved yet, which go after a day.
class LibraryFiles {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using StoredImage = base::OnceCallback<void(std::optional<base::DictValue>)>;

  static base::ListValue SupportedMethods();
  // False leaves callback untouched.
  static bool Dispatch(const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& callback);
  // A page's picture (base64 PNG) in the cache: {path, width, height}.
  static void StoreCapture(std::string base64, StoredImage done);
  // chrome://bay/library-media/<relative>, on a blocking sequence. Null for
  // anything but a file this class named.
  static scoped_refptr<base::RefCountedMemory> ReadAsset(
      std::string_view relative);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_LIBRARY_FILES_H_
