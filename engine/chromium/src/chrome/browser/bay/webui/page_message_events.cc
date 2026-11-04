// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_message_events.h"

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

#include "bay/core/nn_page_channel.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/bay/webui/page_script.g.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/permission_controller.h"
#include "content/public/browser/permission_descriptor_util.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/mojom/permissions/permission_status.mojom.h"
#include "url/origin.h"

namespace bay {
namespace {
constexpr size_t kMaxMessageBytes = 2 * 1024 * 1024;
constexpr size_t kMaxFrames = 256;
constexpr size_t kMaxNotifications = 500;
PageMessageEvents::Sink& EventSink() {
  static base::NoDestructor<PageMessageEvents::Sink> sink;
  return *sink;
}
std::string Json(const base::DictValue& value) {
  return base::WriteJson(value).value_or("{}");
}
std::string Text(const base::DictValue* value, const char* key, size_t limit) {
  const auto* text = value ? value->FindString(key) : nullptr;
  if (!text || !base::IsStringUTF8(*text))
    return {};
  std::u16string clipped = base::UTF8ToUTF16(*text);
  if (clipped.size() > limit) {
    clipped.resize(limit);
    if (!clipped.empty() && clipped.back() >= 0xd800 && clipped.back() <= 0xdbff)
      clipped.pop_back();
  }
  return base::UTF16ToUTF8(clipped);
}
double Number(const base::DictValue* value, const char* key, double fallback) {
  const auto number = value ? value->FindDouble(key) : std::nullopt;
  return number && std::isfinite(*number) ? *number : fallback;
}
bool Flag(const base::DictValue* value, const char* key) {
  return value && value->FindBool(key).value_or(false);
}
content::RenderFrameHost* Frame(content::WebContents* contents,
                                 const std::string& id) {
  content::RenderFrameHost* found = nullptr;
  if (!contents || !contents->GetPrimaryMainFrame())
    return nullptr;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (frame->IsActive() && nncore::PageChannel::FrameId(frame) == id)
          found = frame;
      });
  return found;
}
bool IsFrame(content::WebContents* contents, content::RenderFrameHost* frame) {
  return frame && Frame(contents, nncore::PageChannel::FrameId(frame)) == frame &&
         (frame->GetLastCommittedURL().SchemeIsHTTPOrHTTPS() ||
          frame->GetLastCommittedURL().SchemeIsFile());
}
content::WebContents* Contents(const base::DictValue& payload) {
  const auto id = payload.FindInt("browserId");
  const auto* profile = payload.FindString("profile");
  if (!id || !profile)
    return nullptr;
  auto* page = TabBroker::Get().ContentsForBrowserId(*id);
  auto* owner = page ? Profile::FromBrowserContext(page->GetBrowserContext())
                     : nullptr;
  return owner && owner->GetOriginalProfile()->GetPath().AsUTF8Unsafe() == *profile
             ? page : nullptr;
}
base::Value Rect(const base::DictValue* value) {
  const auto* rect = value ? value->FindDict("rect") : nullptr;
  if (!rect)
    return {};
  base::DictValue result;
  for (const char* key : {"x", "y", "width", "height"}) {
    const auto number = rect->FindDouble(key);
    if (!number || !std::isfinite(*number) ||
        ((std::string_view(key) == "width" || std::string_view(key) == "height") &&
         *number < 0))
      return {};
    result.Set(key, *number);
  }
  return base::Value(std::move(result));
}
base::DictValue NowPlaying(const base::DictValue& value) {
  std::string state = Text(&value, "playbackState", 16);
  if (state != "playing" && state != "paused")
    state = "none";
  base::ListValue actions;
  if (const auto* list = value.FindList("actions"))
    for (const auto& action : *list) {
      if (actions.size() >= 32)
        break;
      if (action.is_string() && action.GetString().size() <= 64)
        actions.Append(action.GetString());
    }
  const auto duration = value.FindDouble("duration");
  const auto artwork = Text(&value, "artwork", 1 << 20);
  return base::DictValue()
      .Set("title", Text(&value, "title", 1024))
      .Set("artist", Text(&value, "artist", 1024))
      .Set("album", Text(&value, "album", 1024))
      .Set("artwork", artwork.empty() ? base::Value() : base::Value(artwork))
      .Set("playbackState", state)
      .Set("position", std::max(0.0, Number(&value, "position", 0)))
      .Set("duration", duration && std::isfinite(*duration) && *duration >= 0
                           ? base::Value(*duration) : base::Value())
      .Set("playbackRate", Number(&value, "playbackRate", 1))
      .Set("timestamp", Number(&value, "timestamp", 0))
      .Set("hasVideo", Flag(&value, "hasVideo"))
      .Set("actions", std::move(actions))
      .Set("live", Flag(&value, "live"))
      .Set("liveBehind", std::max(0.0, Number(&value, "liveBehind", 0)));
}
bool NotificationsAllowed(content::RenderFrameHost* frame) {
  auto* permissions = frame->GetBrowserContext()->GetPermissionController();
  return permissions &&
         permissions->GetPermissionStatusForCurrentDocument(
             content::PermissionDescriptorUtil::CreatePermissionDescriptorForPermissionType(
                 blink::PermissionType::NOTIFICATIONS), frame) ==
             blink::mojom::PermissionStatus::GRANTED;
}
}  // namespace

WEB_CONTENTS_USER_DATA_KEY_IMPL(PageMessageEvents);
PageMessageEvents::PageMessageEvents(content::WebContents* contents)
    : WebContentsObserver(contents), WebContentsUserData<PageMessageEvents>(*contents) {}
PageMessageEvents::~PageMessageEvents() = default;
PageMessageEvents* PageMessageEvents::Get(content::WebContents* contents) {
  CreateForWebContents(contents);
  return FromWebContents(contents);
}
void PageMessageEvents::Start(Sink sink) {
  EventSink() = std::move(sink);
  if (nncore::GetPageScript() != kPageScript)
    nncore::SetPageScript(kPageScript);
}
bool PageMessageEvents::HandleEngineEvent(std::string_view topic,
                                           const base::DictValue& payload) {
  if (topic != "tabs.pageMessage")
    return false;
  const auto* kind = payload.FindString("kind");
  const auto* json = payload.FindString("json");
  const auto* id = payload.FindString("frame");
  auto* contents = Contents(payload);
  if (!contents || !kind || !json || !id || json->size() > kMaxMessageBytes)
    return true;
  auto value = base::JSONReader::Read(*json, base::JSON_PARSE_RFC);
  if (value)
    Handle(contents, Frame(contents, *id), *kind, *value);
  return true;
}
void PageMessageEvents::Handle(content::WebContents* contents,
                                content::RenderFrameHost* frame,
                                const std::string& kind,
                                const base::Value& value) {
  if (IsFrame(contents, frame))
    Get(contents)->Message(frame, kind, value);
}
void PageMessageEvents::Emit(const char* event, base::DictValue payload) {
  if (EventSink())
    EventSink().Run(web_contents(), event, std::move(payload));
}
void PageMessageEvents::EmitNowPlaying() {
  const auto selected = now_playing_.find(selected_frame_);
  if (selected == now_playing_.end())
    selected_frame_ = now_playing_.empty() ? "" : now_playing_.begin()->first;
  for (const auto& [frame, state] : now_playing_)
    if (state.FindString("playbackState") &&
        *state.FindString("playbackState") == "playing") {
      selected_frame_ = frame;
      break;
    }
  const auto found = now_playing_.find(selected_frame_);
  Emit("onNowPlaying", base::DictValue().Set(
      "state", found == now_playing_.end() ? base::Value()
                                           : base::Value(found->second.Clone())));
}
void PageMessageEvents::EmitMedia() {
  Emit("onMedia", MediaState(web_contents()));
}
base::DictValue PageMessageEvents::MediaState(content::WebContents* contents) {
  const auto* state = FromWebContents(contents);
  const bool playing = state && state->script_media_seen_
                           ? std::ranges::any_of(state->playing_, [](const auto& entry) {
                               return entry.second;
                             })
                           : contents->IsCurrentlyAudible();
  return base::DictValue()
      .Set("playing", playing)
      .Set("muted", contents->IsAudioMuted());
}
void PageMessageEvents::Message(content::RenderFrameHost* frame,
                                const std::string& kind,
                                const base::Value& value) {
  const auto* data = value.GetIfDict();
  const auto id = nncore::PageChannel::FrameId(frame);
  const bool main = frame == web_contents()->GetPrimaryMainFrame();
  if (kind == "hello") {
    auto* profile = Profile::FromBrowserContext(web_contents()->GetBrowserContext());
    const auto top = web_contents()->GetLastCommittedURL();
    auto* settings = HostContentSettingsMapFactory::GetForProfile(profile);
    const bool block = settings && settings->GetContentSetting(
        top, top, ContentSettingsType::AUTOPLAY) == CONTENT_SETTING_BLOCK;
    // Desktop capture goes through Chrome's picker hook, including Wayland's
    // portal. Do not enable the macOS page script's getDisplayMedia shim.
    nncore::PageChannel::GetOrCreate(web_contents())->CallFrame(
        id, "config", Json(base::DictValue().Set("blockAutoplay", block)));
    return;
  }
  if (kind == "nowPlaying") {
    if (!data && !value.is_none())
      return;
    if (!data)
      now_playing_.erase(id);
    else if (now_playing_.size() < kMaxFrames || now_playing_.contains(id)) {
      now_playing_.insert_or_assign(id, NowPlaying(*data));
      selected_frame_ = id;
    }
    EmitNowPlaying();
    return;
  }
  if (kind == "media" && data) {
    if (playing_.size() >= kMaxFrames && !playing_.contains(id))
      return;
    script_media_seen_ = true;
    playing_[id] = Flag(data, "playing");
    EmitMedia();
    return;
  }
  if (kind == "notification" && data) {
    const auto page_id = Text(data, "id", 128);
    const auto* title = data->FindString("title");
    const auto origin = frame->GetLastCommittedOrigin();
    if (page_id.empty() || !title || origin.opaque() ||
        !NotificationsAllowed(frame))
      return;
    const auto external_id = id + "|" + page_id;
    auto icon = Text(data, "icon", 1 << 20);
    const GURL icon_url(icon);
    if (!icon_url.SchemeIsHTTPOrHTTPS() &&
        !base::StartsWith(icon, "data:image/"))
      icon.clear();
    auto payload = base::DictValue()
        .Set("id", external_id).Set("title", Text(data, "title", 1024))
        .Set("body", Text(data, "body", 4096))
        .Set("icon", icon.empty() ? base::Value() : base::Value(icon))
        .Set("tag", Text(data, "tag", 1024))
        .Set("silent", Flag(data, "silent"))
        .Set("requireInteraction", Flag(data, "requireInteraction"))
        .Set("origin", origin.Serialize())
        .Set("browserId", sessions::SessionTabHelper::IdForTab(web_contents()).id())
        .Set("isMainFrame", main);
    std::vector<std::string> replaced;
    const auto tag = Text(data, "tag", 1024);
    if (!tag.empty()) {
      for (auto old = notifications_.begin(); old != notifications_.end();) {
        if (old->first != external_id &&
            old->second.payload.FindString("tag") &&
            *old->second.payload.FindString("tag") == tag &&
            old->second.payload.FindString("origin") &&
            *old->second.payload.FindString("origin") == origin.Serialize()) {
          replaced.push_back(old->first);
          old = notifications_.erase(old);
        } else {
          ++old;
        }
      }
    }
    if (notifications_.size() >= kMaxNotifications &&
        !notifications_.contains(external_id))
      return;
    notifications_.insert_or_assign(external_id, Notification{id, page_id, payload.Clone()});
    auto weak = weak_factory_.GetWeakPtr();
    for (const auto& old : replaced) {
      if (!weak)
        return;
      weak->Emit("onNotificationClose", base::DictValue().Set("id", old));
    }
    if (weak)
      weak->Emit("onNotification", std::move(payload));
    return;
  }
  if (kind == "notificationClose" && data) {
    const auto external_id = id + "|" + Text(data, "id", 128);
    if (!notifications_.erase(external_id))
      return;
    Emit("onNotificationClose", base::DictValue().Set("id", external_id));
    return;
  }
  if (!main)
    return;
  base::Value filtered;
  if (kind == "selection") {
    auto rect = Rect(data);
    if (data && data->FindString("text") && !rect.is_none())
      filtered = base::Value(base::DictValue().Set("text", Text(data, "text", 4000))
                                 .Set("rect", std::move(rect)));
  } else if ((kind == "devMode" || kind == "capture" ||
              kind == "captureGesture" || kind == "boost") && data) {
    filtered = value.Clone();
  } else if (kind == "scroll" && data) {
    const auto state = Text(data, "state", 8);
    if (state != "up" && state != "down" && state != "top")
      return;
    filtered = base::Value(base::DictValue().Set("state", state));
  } else if (kind == "linkPreview") {
    auto rect = Rect(data);
    const GURL url(Text(data, "url", 8192));
    if (url.is_valid() && url.SchemeIsHTTPOrHTTPS() && !rect.is_none())
      filtered = base::Value(base::DictValue().Set("url", url.spec())
                                  .Set("rect", std::move(rect)));
  } else {
    return;
  }
  Emit("onPageMessage", base::DictValue().Set("kind", kind)
                           .Set("data", std::move(filtered)));
}
void PageMessageEvents::Replay(content::WebContents* contents, ReplaySink sink) {
  auto* state = FromWebContents(contents);
  if (!state)
    return;
  std::vector<std::pair<const char*, base::DictValue>> replay;
  auto now = state->now_playing_.find(state->selected_frame_);
  replay.emplace_back("onMedia", MediaState(contents));
  replay.emplace_back("onNowPlaying", base::DictValue().Set(
      "state", now == state->now_playing_.end() ? base::Value()
                                                : base::Value(now->second.Clone())));
  for (const auto& [id, notification] : state->notifications_)
    replay.emplace_back("onNotification", notification.payload.Clone());
  for (auto& [event, payload] : replay)
    sink.Run(event, std::move(payload));
}
bool PageMessageEvents::Dispatch(content::WebContents* contents,
                                  const std::string& command,
                                  const base::ListValue& params,
                                  Response& response) {
  if (command != "notificationAction" && command != "mediaCommand")
    return false;
  auto* state = FromWebContents(contents);
  bool handled = false;
  if (command == "notificationAction" && params.size() == 2 &&
      params[0].is_string() && params[1].is_string() &&
      (params[1].GetString() == "click" || params[1].GetString() == "close")) {
    handled = true;
    if (!state) {
      std::move(response).Run("{\"value\":null}");
      return true;
    }
    const auto found = state->notifications_.find(params[0].GetString());
    const auto action = params[1].GetString();
    if (found != state->notifications_.end() &&
        (action == "click" || action == "close")) {
      const auto frame_id = found->second.frame;
      const auto page_id = found->second.page_id;
      if (action == "close")
        state->notifications_.erase(found);
      if (Frame(contents, frame_id)) {
        nncore::PageChannel::GetOrCreate(contents)->CallFrame(
            frame_id, "notification", Json(base::DictValue()
                .Set("id", page_id).Set("action", action)));
      }
    }
  } else if (state && command == "mediaCommand" && !params.empty() &&
             params[0].is_string() && Frame(contents, state->selected_frame_)) {
    const auto action = params[0].GetString();
    const auto seconds = params.size() > 1 && !params[1].is_none()
                             ? params[1].GetIfDouble()
                             : std::make_optional(0.0);
    if (seconds && std::isfinite(*seconds) &&
        (action == "play" || action == "pause" || action == "toggle" ||
         action == "next" || action == "previous" || action == "stop" ||
         action == "seekBy" || action == "seekTo" || action == "seekToLive")) {
      nncore::PageChannel::GetOrCreate(contents)->CallFrame(
          state->selected_frame_, "media", Json(base::DictValue()
              .Set("action", action).Set("seconds", *seconds)));
      handled = true;
    }
  }
  if (command == "mediaCommand" && !handled)
    return false;  // Chrome's native MediaSession remains the fallback.
  std::move(response).Run(handled ? "{\"value\":null}" :
      "{\"error\":{\"code\":\"invalid_args\",\"message\":\"Invalid notification action\"}}");
  return true;
}
void PageMessageEvents::RemoveFrame(const std::string& id) {
  std::vector<std::pair<const char*, base::DictValue>> events;
  for (auto it = notifications_.begin(); it != notifications_.end();) {
    if (it->second.frame == id) {
      events.emplace_back("onNotificationClose", base::DictValue().Set("id", it->first));
      it = notifications_.erase(it);
    } else {
      ++it;
    }
  }
  const bool now_changed = now_playing_.erase(id);
  const bool media_changed = playing_.erase(id);
  auto weak = weak_factory_.GetWeakPtr();
  for (auto& [event, value] : events) {
    if (!weak)
      return;
    weak->Emit(event, std::move(value));
  }
  if (weak && now_changed)
    weak->EmitNowPlaying();
  if (weak && media_changed)
    weak->EmitMedia();
}
void PageMessageEvents::Reset() {
  std::vector<std::string> notifications;
  for (const auto& [id, notification] : notifications_)
    notifications.push_back(id);
  const bool now_changed = !now_playing_.empty();
  const bool media_changed = !playing_.empty();
  notifications_.clear();
  now_playing_.clear();
  playing_.clear();
  selected_frame_.clear();
  script_media_seen_ = true;
  auto weak = weak_factory_.GetWeakPtr();
  for (const auto& id : notifications) {
    if (!weak)
      return;
    weak->Emit("onNotificationClose", base::DictValue().Set("id", id));
  }
  if (weak && now_changed)
    weak->EmitNowPlaying();
  if (weak && media_changed)
    weak->EmitMedia();
}
void PageMessageEvents::PrimaryPageChanged(content::Page&) { Reset(); }
void PageMessageEvents::PrimaryMainFrameRenderProcessGone(base::TerminationStatus) { Reset(); }
void PageMessageEvents::WebContentsDestroyed() { Reset(); }
void PageMessageEvents::RenderFrameDeleted(content::RenderFrameHost* frame) {
  RemoveFrame(nncore::PageChannel::FrameId(frame));
}
void PageMessageEvents::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (navigation->HasCommitted() && !navigation->IsSameDocument() &&
      !navigation->IsInPrimaryMainFrame())
    RemoveFrame(nncore::PageChannel::FrameId(navigation->GetRenderFrameHost()));
}
}  // namespace bay
