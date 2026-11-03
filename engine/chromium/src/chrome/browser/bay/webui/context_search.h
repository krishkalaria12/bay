// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CONTEXT_SEARCH_H_
#define CHROME_BROWSER_BAY_WEBUI_CONTEXT_SEARCH_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace bay {

// "Search <engine> for “…”" in a page's menu, as macOS's context menu: the app's
// own search engine and opening rules (onCommand "search") in place of Chrome's
// default provider. Chrome keeps its item for editable text and for a selection
// that is a URL ("Go to …").
class ContextSearch {
 public:
  using ViewSink = base::RepeatingCallback<
      bool(content::WebContents*, const char* event, base::DictValue payload)>;

  // Installs the menu's hooks (chromium-context-search-webui.patch). Later
  // calls replace the sink.
  static void Start(ViewSink sink);
  static void SetEngineName(const std::string& name);

  // Whitespace collapsed, cut near 50 characters at a word, '&' escaped for
  // the menu: "Search Kagi for “…”".
  static std::u16string Title(const std::u16string& selection);
  // The app's click modifiers for a menu item's event flags. Control is the
  // desktop's primary modifier, what the app calls metaKey.
  static base::DictValue Modifiers(int event_flags);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_CONTEXT_SEARCH_H_
