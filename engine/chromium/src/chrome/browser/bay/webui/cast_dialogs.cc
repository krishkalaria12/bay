// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/cast_dialogs.h"

#include <utility>

#include "bay/core/nn_cast_dialogs.h"
#include "base/functional/bind.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"

// Defined in Chrome's dialog controller (chromium-chrome-dialogs-webui.patch).
extern bool (*g_bay_wants_cast_dialog)(content::WebContents* initiator);
extern bool (*g_bay_cast_dialog)(content::WebContents* initiator,
                                 media_router::MediaRouterUI* ui);

namespace bay {
namespace {

// A window Chrome made itself keeps Chrome's dialog.
bool WantsDialog(content::WebContents* initiator) {
  return WindowRegistry::Get().HoldsTab(initiator);
}

bool HandleDialog(content::WebContents* initiator,
                  media_router::MediaRouterUI* ui) {
  if (!ui || !WantsDialog(initiator))
    return false;
  nncore::cast::Adopt(initiator, ui);
  return true;
}

}  // namespace

// static
void CastDialogs::Start(Sink sink) {
  nncore::cast::SetTell(base::BindRepeating(
      [](const Sink& sink, content::WebContents* initiator,
         base::DictValue state) {
        state.Set("browserId",
                  sessions::SessionTabHelper::IdForTab(initiator).id());
        return sink.Run(initiator, "onCastDialog", std::move(state));
      },
      std::move(sink)));
  g_bay_wants_cast_dialog = &WantsDialog;
  g_bay_cast_dialog = &HandleDialog;
}

// static
bool CastDialogs::StartCasting(int id, const std::string& sink, int cast_mode) {
  return nncore::cast::StartCasting(id, sink, cast_mode);
}

// static
void CastDialogs::StopCasting(int id, const std::string& route) {
  nncore::cast::StopCasting(id, route);
}

// static
void CastDialogs::Close(int id) {
  nncore::cast::Close(id);
}

// static
base::DictValue CastDialogs::DescribeSink(
    const media_router::UIMediaSink& sink) {
  return nncore::cast::DescribeSink(sink);
}

}  // namespace bay
