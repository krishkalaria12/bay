// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/context_search.h"

#include <utility>
#include <vector>

#include "base/no_destructor.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/third_party/icu/icu_utf.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/web_contents.h"
#include "ui/events/event_constants.h"

// Defined in Chrome's page menu (chromium-context-search-webui.patch).
extern std::u16string (*g_bay_context_search_title)(
    content::WebContents* contents,
    const content::ContextMenuParams& params);
extern bool (*g_bay_context_search)(content::WebContents* contents,
                                    const std::u16string& selection,
                                    int event_flags);

namespace bay {
namespace {

constexpr size_t kMaxLabel = 50;

std::string& EngineName() {
  static base::NoDestructor<std::string> name("Google");
  return *name;
}

ContextSearch::ViewSink& Sink() {
  static base::NoDestructor<ContextSearch::ViewSink> sink;
  return *sink;
}

std::u16string TitleForMenu(content::WebContents* contents,
                            const content::ContextMenuParams& params) {
  if (params.is_editable || params.selection_text.empty() ||
      !WindowRegistry::Get().HoldsTab(contents)) {
    return std::u16string();
  }
  return ContextSearch::Title(params.selection_text);
}

bool RunSearch(content::WebContents* contents,
               const std::u16string& selection,
               int event_flags) {
  if (!WindowRegistry::Get().HoldsTab(contents) || !Sink())
    return false;
  return Sink().Run(contents, "onCommand",
                    base::DictValue()
                        .Set("command", "search")
                        .Set("text", base::UTF16ToUTF8(selection))
                        .Set("modifiers", ContextSearch::Modifiers(event_flags)));
}

}  // namespace

// static
void ContextSearch::Start(ViewSink sink) {
  Sink() = std::move(sink);
  g_bay_context_search_title = &TitleForMenu;
  g_bay_context_search = &RunSearch;
}

// static
void ContextSearch::SetEngineName(const std::string& name) {
  EngineName() = name.empty() ? "Google" : name;
}

// static
std::u16string ContextSearch::Title(const std::u16string& selection) {
  const std::vector<std::u16string_view> words = base::SplitStringPiece(
      selection, base::kWhitespaceUTF16, base::TRIM_WHITESPACE,
      base::SPLIT_WANT_NONEMPTY);
  std::u16string label = base::JoinString(words, u" ");
  if (label.size() > kMaxLabel) {
    const size_t space = label.rfind(u' ', kMaxLabel - 1);
    size_t end = space != std::u16string::npos && space > kMaxLabel / 2
                     ? space
                     : kMaxLabel;
    // Not through the middle of a surrogate pair.
    if (end < label.size() && CBU16_IS_TRAIL(label[end]))
      --end;
    label = label.substr(0, end) + u"…";
  }
  std::u16string title = u"Search " + base::UTF8ToUTF16(EngineName()) +
                         u" for “" + label + u"”";
  base::ReplaceSubstringsAfterOffset(&title, 0, u"&", u"&&");
  return title;
}

// static
base::DictValue ContextSearch::Modifiers(int event_flags) {
  return base::DictValue()
      .Set("metaKey", (event_flags & ui::EF_CONTROL_DOWN) != 0)
      .Set("shiftKey", (event_flags & ui::EF_SHIFT_DOWN) != 0)
      .Set("altKey", (event_flags & ui::EF_ALT_DOWN) != 0);
}

}  // namespace bay
