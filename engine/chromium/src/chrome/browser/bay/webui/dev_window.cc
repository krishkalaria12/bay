// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/dev_window.h"

#include <cmath>
#include <limits>
#include <optional>
#include <set>
#include <utility>
#include <vector>

#include "base/environment.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/strings/stringprintf.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "bay/core/nn_devtools_call.h"
#include "chrome/browser/bay/webui/dev_window_input.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/base_window.h"
#include "ui/views/widget/widget.h"

#if defined(USE_AURA)
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#endif

namespace bay {
namespace {
std::string Reply(base::Value value) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}
std::optional<int> Id(const base::ListValue& args, size_t index) {
  if (index >= args.size() ||
      (!args[index].is_int() && !args[index].is_double()))
    return std::nullopt;
  const double id = args[index].GetDouble();
  if (!std::isfinite(id) || id <= 0 || std::trunc(id) != id ||
      id > std::numeric_limits<int>::max())
    return std::nullopt;
  return static_cast<int>(id);
}
bool Owns(const HostContext& context, BrowserWindowInterface* frame) {
  if (!frame || !context.profile())
    return false;
  if (context.is_window())
    return context.window() == frame;
  return !WindowRegistry::Get().IdFor(frame).empty();
}
BrowserWindowInterface* FindFrame(const HostContext& context, int id) {
  BrowserWindowInterface* result = nullptr;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        auto* frame = WindowRegistry::Get().FrameOf(browser);
        if (frame && frame->GetSessionID().id() == id && Owns(context, frame))
          result = frame;
        return !result;
      });
  return result;
}
views::Widget* WidgetOf(BrowserWindowInterface* frame) {
  auto* window = WebUIBrowserWindow::FromBrowser(frame);
  return window ? window->widget() : nullptr;
}
base::ListValue Rect(const gfx::Rect& bounds) {
  return base::ListValue()
      .Append(bounds.x())
      .Append(bounds.y())
      .Append(bounds.width())
      .Append(bounds.height());
}
content::WebContents* ActivePage(BrowserWindowInterface* frame) {
  auto* strip = frame->GetTabStripModel();
  return strip ? strip->GetActiveWebContents() : nullptr;
}
std::string ProfileId(BrowserWindowInterface* frame) {
  if (frame->GetProfile()->IsOffTheRecord())
    return "incognito:" + WindowRegistry::Get().IdFor(frame);
  const auto name = frame->GetProfile()->GetPath().BaseName().AsUTF8Unsafe();
  return name == "Default" ? "" : name;
}
base::DictValue Describe(BrowserWindowInterface* frame) {
  auto* window = frame->GetWindow();
  auto* widget = WidgetOf(frame);
  auto* active = ActivePage(frame);
  auto state =
      base::DictValue()
          .Set("window", frame->GetSessionID().id())
          .Set("appWindow", WindowRegistry::Get().IdFor(frame))
          .Set("profile", ProfileId(frame))
          .Set("frame", window->GetBounds().ToString())
          .Set("bounds", Rect(window->GetBounds()))
          .Set("globalCoordinates", true)
          .Set("key", window->IsActive())
          .Set("active", window->IsActive())
          .Set("visible", window->IsVisible())
          .Set("minimized", window->IsMinimized())
          .Set("maximized", window->IsMaximized())
          .Set("fullScreen", window->IsFullscreen())
          .Set("pageFullScreen", active && active->IsFullscreen())
          .Set("ready", widget != nullptr)
          .Set("hosting", widget != nullptr)
          .Set("hasRoot", widget != nullptr)
          .Set("anyTabBrowserId",
               active ? sessions::SessionTabHelper::IdForTab(active).id() : 0);
  if (widget)
    state.Set("canBecomeKey", widget->CanActivate());
  return state;
}
base::ListValue Windows(const HostContext& context) {
  base::ListValue result;
  std::set<int> emitted;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        auto* frame = WindowRegistry::Get().FrameOf(browser);
        if (Owns(context, frame) && frame->GetWindow() &&
            emitted.insert(frame->GetSessionID().id()).second)
          result.Append(Describe(frame));
        return true;
      });
  return result;
}
int NumberForTab(const HostContext& context, int id) {
  int result = 0;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        auto* frame = WindowRegistry::Get().FrameOf(browser);
        if (!Owns(context, frame))
          return true;
        auto* tabs = browser->GetTabStripModel();
        for (int index = 0; tabs && index < tabs->count(); ++index) {
          if (sessions::SessionTabHelper::IdForTab(
                  tabs->GetWebContentsAt(index))
                  .id() == id) {
            result = frame->GetSessionID().id();
            return false;
          }
        }
        return true;
      });
  return result;
}
bool ReadOnly(const std::string& action) {
  return action == "winfo" || action == "fullScreen" || action == "children" ||
         action == "tabviews" || action == "responder" ||
         action.starts_with("hit:");
}
aura::WindowTreeHost* HostOf(BrowserWindowInterface* frame) {
#if defined(USE_AURA)
  auto* widget = WidgetOf(frame);
  if (!widget)
    return nullptr;
  aura::Window* window = widget->GetNativeWindow();
  return window ? window->GetHost() : nullptr;
#else
  return nullptr;
#endif
}
// Sent after the reply, as a click on macOS is: the action's caller isn't
// waiting on what the input does, which may close the window.
void PostMouse(BrowserWindowInterface* frame,
               const std::vector<DevMouseStep>& steps) {
  for (const auto& step : steps) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<BrowserWindowInterface> frame, DevMouseStep step) {
              if (auto* host = frame ? HostOf(frame.get()) : nullptr)
                SendDevMouse(host, step);
            },
            frame->GetWeakPtr(), step),
        step.delay);
  }
}
void PostKeys(BrowserWindowInterface* frame,
              const std::vector<DevKeyStep>& steps) {
  for (const auto& step : steps) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<BrowserWindowInterface> frame, DevKeyStep step) {
              if (auto* host = frame ? HostOf(frame.get()) : nullptr)
                SendDevKey(host, step);
            },
            frame->GetWeakPtr(), step));
  }
}
bool IsInputAction(const std::string& action) {
  return action.starts_with("click:") || action.starts_with("mouse:") ||
         action.starts_with("drag:") || action.starts_with("keys:") ||
         action.starts_with("type:");
}
// "hit:<x>,<y>": what the window's document has at the point, by its renderer's
// own hit test ("tag#id[label]"); a page shows as its embed element.
void HitTest(BrowserWindowInterface* frame,
             const gfx::PointF& point,
             DevWindow::Response response) {
  auto* document = WindowRegistry::Get().DocumentOf(frame);
  if (!document) {
    std::move(response).Run(
        Failure("no_document", "This window has no document to hit test"));
    return;
  }
  nncore::CallDevTools(
      document, "Runtime.evaluate",
      base::DictValue()
          .Set("expression",
               base::StringPrintf(
                   "(()=>{const e=document.elementFromPoint(%f,%f);if(!e)"
                   "return\"\";const l=e.getAttribute(\"aria-label\");return "
                   "e.tagName.toLowerCase()+(e.id?\"#\"+e.id:\"\")+"
                   "(l?\"[\"+l+\"]\":\"\")})()",
                   point.x(), point.y()))
          .Set("returnByValue", true),
      base::Seconds(5),
      base::BindOnce(
          [](DevWindow::Response response,
             std::optional<base::DictValue> result,
             std::optional<std::string> error) {
            const auto* value =
                result ? result->FindStringByDottedPath("result.value")
                       : nullptr;
            if (!value) {
              std::move(response).Run(Failure(
                  "hit_test_failed", error ? error->c_str() : "no result"));
              return;
            }
            std::move(response).Run(Reply(base::Value(*value)));
          },
          std::move(response)));
}
base::ListValue Children(BrowserWindowInterface* frame) {
  base::ListValue result;
  auto* widget = WidgetOf(frame);
  if (!widget)
    return result;
  for (const auto& child :
       views::Widget::GetAllChildWidgets(widget->GetNativeView())) {
    if (child == widget)
      continue;
    result.Append(base::DictValue()
                      .Set("class", child->GetName())
                      .Set("frame", child->GetWindowBoundsInScreen().ToString())
                      .Set("visible", child->IsVisible()));
  }
  return result;
}
base::ListValue TabViews(BrowserWindowInterface* frame) {
  base::ListValue result;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        if (WindowRegistry::Get().FrameOf(browser) != frame)
          return true;
        auto* tabs = browser->GetTabStripModel();
        for (int i = 0; tabs && i < tabs->count(); ++i) {
          auto* page = tabs->GetWebContentsAt(i);
          if (!TabBroker::Get().Tracks(page))
            continue;
          result.Append(
              base::DictValue()
                  .Set("browserId",
                       sessions::SessionTabHelper::IdForTab(page).id())
                  .Set("key", TabBroker::Get().KeyFor(page))
                  .Set("frame", page->GetContainerBounds().ToString())
                  .Set("visible",
                       page->GetVisibility() == content::Visibility::VISIBLE));
        }
        return true;
      });
  return result;
}
std::string Visibility(const ui::BaseWindow* window) {
  return window->IsVisible() ? "visible=1" : "visible=0";
}
bool Action(BrowserWindowInterface* frame,
            const std::string& action,
            std::string& result) {
  auto* window = frame->GetWindow();
  if (action == "winfo" || action == "fullScreen") {
    result = base::WriteJson(Describe(frame)).value_or("{}");
  } else if (action == "children") {
    result = base::WriteJson(Children(frame)).value_or("[]");
  } else if (action == "tabviews") {
    result = base::WriteJson(TabViews(frame)).value_or("[]");
  } else if (action == "responder") {
    auto* page = ActivePage(frame);
    auto* focused = page ? page->GetFocusedFrame() : nullptr;
    result =
        base::WriteJson(
            base::DictValue()
                .Set("browserId",
                     focused ? sessions::SessionTabHelper::IdForTab(page).id()
                             : 0)
                .Set("origin",
                     focused ? focused->GetLastCommittedOrigin().Serialize()
                             : ""))
            .value_or("{}");
  } else if (action == "fakeActiveClicks") {
    // Only AppKit keeps a first click from an inactive app to itself.
    result = "1";
  } else if (action.starts_with("fakeFullScreen:")) {
    // Real full screen, on the isolated instances this action is limited to.
    auto* widget = WidgetOf(frame);
    if (!widget || (action != "fakeFullScreen:1" && action != "fakeFullScreen:0"))
      return false;
    widget->SetFullscreen(action == "fakeFullScreen:1");
    result = base::WriteJson(Describe(frame)).value_or("{}");
  } else if (action == "show" || action == "ns:in" || action == "ns:front") {
    window->Show();
    result = Visibility(window);
  } else if (action == "hide" || action == "ns:out") {
    window->Hide();
    result = Visibility(window);
  } else if (action == "activate") {
    window->Activate();
    result = "ok";
  } else if (action == "deactivate") {
    window->Deactivate();
    result = "ok";
  } else if (action == "minimize") {
    window->Minimize();
    result = "ok";
  } else if (action == "maximize") {
    window->Maximize();
    result = "ok";
  } else if (action == "restore") {
    window->Restore();
    result = "ok";
  } else if (action == "close-button" || action == "performClose") {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<BrowserWindowInterface> frame) {
                         if (frame && frame->GetWindow())
                           frame->GetWindow()->Close();
                       },
                       frame->GetWeakPtr()));
    result = action == "close-button" ? "clicked" : "ok";
  } else {
    return false;
  }
  return true;
}
}  // namespace

bool DevWindow::Dispatch(const HostContext& context,
                         const std::string& method,
                         const base::ListValue& args,
                         Response& response) {
  if (method != "chromeWindows" && method != "devWindowNumber" &&
      method != "devWindow")
    return false;
  auto invalid = [&] {
    std::move(response).Run(
        Failure("invalid_args", "Invalid developer window arguments"));
  };
  if (!context.profile()) {
    std::move(response).Run(Failure("profile_unavailable",
                                    "The host profile is no longer available"));
    return true;
  }
  if (method == "chromeWindows") {
    if (!args.empty())
      invalid();
    else
      std::move(response).Run(Reply(base::Value(Windows(context))));
    return true;
  }
  const auto id = Id(args, 0);
  if (!id ||
      (method == "devWindowNumber" ? args.size() != 1 : args.size() != 2)) {
    invalid();
    return true;
  }
  if (method == "devWindowNumber") {
    std::move(response).Run(Reply(base::Value(NumberForTab(context, *id))));
    return true;
  }
  auto* frame = FindFrame(context, *id);
  if (!frame || !frame->GetWindow()) {
    std::move(response).Run(
        Failure("no_window", "This host does not own that Bay window"));
    return true;
  }
  const auto* action = args[1].GetIfString();
  if (!action || action->empty() || action->size() > 128) {
    invalid();
    return true;
  }
  if (!ReadOnly(*action) && base::Environment::Create()
                                ->GetVar("BAY_DATA_DIR")
                                .value_or("")
                                .empty()) {
    std::move(response).Run(Failure("permission_denied",
                                    "Developer window mutations require an "
                                    "isolated BAY_DATA_DIR instance"));
    return true;
  }
  if (action->starts_with("hit:")) {
    const auto point = ParseDevPoint(action->substr(4));
    if (!point)
      invalid();
    else
      HitTest(frame, *point, std::move(response));
    return true;
  }
  if (IsInputAction(*action)) {
    const auto mouse = ParseDevMouseAction(*action);
    const auto keys = ParseDevKeyAction(*action);
    if (!mouse && !keys) {
      invalid();
    } else if (!HostOf(frame)) {
      std::move(response).Run(Failure(
          "no_widget", "This window has no native surface to send input to"));
    } else if (mouse) {
      PostMouse(frame, *mouse);
      std::move(response).Run(Reply(base::Value(base::StringPrintf(
          "window (%zu events)", mouse->size()))));
    } else {
      PostKeys(frame, *keys);
      std::move(response).Run(Reply(base::Value(base::StringPrintf(
          "keyDown (%zu events)", keys->size()))));
    }
    return true;
  }
  std::string result;
  if (!Action(frame, *action, result)) {
    std::move(response).Run(
        Failure("unsupported_action",
                "This developer action has no desktop-host implementation"));
    return true;
  }
  std::move(response).Run(Reply(base::Value(std::move(result))));
  return true;
}
}  // namespace bay
