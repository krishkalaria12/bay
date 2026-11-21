// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/dev_window_input.h"

#include <cmath>
#include <cstdint>
#include <string>
#include <tuple>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/utf_string_conversions.h"
#include "ui/aura/window_tree_host.h"
#include "ui/events/event.h"
#include "ui/events/keycodes/keyboard_code_conversion.h"

namespace bay {
namespace {

// macOS's drag: each leg's moves, and how they're spaced after the press.
constexpr int kDragMovesPerLeg = 12;
constexpr int kDragFirstDelayMs = 150;
constexpr int kDragSpacingMs = 16;
constexpr size_t kMaxDragPoints = 32;
constexpr double kMaxCoordinate = 100000;

// NSEvent's modifier flags.
constexpr int64_t kNSShift = 1 << 17;
constexpr int64_t kNSControl = 1 << 18;
constexpr int64_t kNSOption = 1 << 19;
constexpr int64_t kNSCommand = 1 << 20;

std::vector<std::string_view> Split(std::string_view text,
                                    std::string_view separator) {
  return base::SplitStringPiece(text, separator, base::KEEP_WHITESPACE,
                                base::SPLIT_WANT_ALL);
}

DevMouseStep Mouse(ui::EventType type,
                   const gfx::PointF& point,
                   int button,
                   int click_count = 0) {
  DevMouseStep step;
  step.type = type;
  step.point = point;
  if (type != ui::EventType::kMouseMoved)
    step.flags = button;
  if (type == ui::EventType::kMousePressed ||
      type == ui::EventType::kMouseReleased) {
    step.changed_flags = button;
    step.click_count = click_count;
  }
  return step;
}

std::optional<std::vector<DevMouseStep>> ParseClick(std::string_view spec) {
  auto point = ParseDevPoint(spec);
  if (!point)
    return std::nullopt;
  const auto parts = Split(spec, ",");
  if (parts.size() > 3 || (parts.size() == 3 && parts[2] != "right"))
    return std::nullopt;
  const int button = parts.size() == 3 ? ui::EF_RIGHT_MOUSE_BUTTON
                                       : ui::EF_LEFT_MOUSE_BUTTON;
  return std::vector<DevMouseStep>{
      Mouse(ui::EventType::kMouseMoved, *point, button),
      Mouse(ui::EventType::kMousePressed, *point, button, 1),
      Mouse(ui::EventType::kMouseReleased, *point, button, 1)};
}

std::optional<std::vector<DevMouseStep>> ParseOne(std::string_view spec) {
  const auto parts = Split(spec, ":");
  if (parts.size() != 2)
    return std::nullopt;
  ui::EventType type;
  if (parts[0] == "down")
    type = ui::EventType::kMousePressed;
  else if (parts[0] == "up")
    type = ui::EventType::kMouseReleased;
  else if (parts[0] == "dragged")
    type = ui::EventType::kMouseDragged;
  else if (parts[0] == "moved")
    type = ui::EventType::kMouseMoved;
  else
    return std::nullopt;
  auto point = ParseDevPoint(parts[1]);
  if (!point)
    return std::nullopt;
  const auto numbers = Split(parts[1], ",");
  int clicks = 1;
  if (numbers.size() > 3 || (numbers.size() == 3 &&
                             (!base::StringToInt(numbers[2], &clicks) ||
                              clicks < 1 || clicks > 3))) {
    return std::nullopt;
  }
  return std::vector<DevMouseStep>{
      Mouse(type, *point, ui::EF_LEFT_MOUSE_BUTTON, clicks)};
}

std::optional<std::vector<DevMouseStep>> ParseDrag(std::string_view spec) {
  std::vector<gfx::PointF> points;
  for (const auto part : Split(spec, ";")) {
    auto point = ParseDevPoint(part);
    if (!point)
      return std::nullopt;
    points.push_back(*point);
  }
  if (points.size() < 2 || points.size() > kMaxDragPoints)
    return std::nullopt;
  const int button = ui::EF_LEFT_MOUSE_BUTTON;
  std::vector<DevMouseStep> steps{
      Mouse(ui::EventType::kMouseMoved, points[0], button),
      Mouse(ui::EventType::kMousePressed, points[0], button, 1)};
  int sent = 1;
  const auto delay = [&sent] {
    return base::Milliseconds(kDragFirstDelayMs + sent++ * kDragSpacingMs);
  };
  for (size_t leg = 1; leg < points.size(); ++leg) {
    const gfx::PointF& a = points[leg - 1];
    const gfx::PointF& b = points[leg];
    for (int k = 1; k <= kDragMovesPerLeg; ++k) {
      const float t = static_cast<float>(k) / kDragMovesPerLeg;
      auto step = Mouse(ui::EventType::kMouseDragged,
                        gfx::PointF(a.x() + (b.x() - a.x()) * t,
                                    a.y() + (b.y() - a.y()) * t),
                        button);
      step.delay = delay();
      steps.push_back(step);
    }
  }
  auto release =
      Mouse(ui::EventType::kMouseReleased, points.back(), button, 1);
  release.delay = delay();
  steps.push_back(release);
  return steps;
}

struct NamedKey {
  int mac_code;
  ui::KeyboardCode key;
  ui::DomKey dom_key;
};
constexpr NamedKey kNamedKeys[] = {
    {36, ui::VKEY_RETURN, ui::DomKey::ENTER},
    {48, ui::VKEY_TAB, ui::DomKey::TAB},
    {51, ui::VKEY_BACK, ui::DomKey::BACKSPACE},
    {53, ui::VKEY_ESCAPE, ui::DomKey::ESCAPE},
    {123, ui::VKEY_LEFT, ui::DomKey::ARROW_LEFT},
    {124, ui::VKEY_RIGHT, ui::DomKey::ARROW_RIGHT},
    {125, ui::VKEY_DOWN, ui::DomKey::ARROW_DOWN},
    {126, ui::VKEY_UP, ui::DomKey::ARROW_UP},
    {115, ui::VKEY_HOME, ui::DomKey::HOME},
    {119, ui::VKEY_END, ui::DomKey::END},
    {116, ui::VKEY_PRIOR, ui::DomKey::PAGE_UP},
    {121, ui::VKEY_NEXT, ui::DomKey::PAGE_DOWN},
    {117, ui::VKEY_DELETE, ui::DomKey::DEL},
    {122, ui::VKEY_F1, ui::DomKey::F1},
    {120, ui::VKEY_F2, ui::DomKey::F2},
    {99, ui::VKEY_F3, ui::DomKey::F3},
    {118, ui::VKEY_F4, ui::DomKey::F4},
    {96, ui::VKEY_F5, ui::DomKey::F5},
    {97, ui::VKEY_F6, ui::DomKey::F6},
    {98, ui::VKEY_F7, ui::DomKey::F7},
    {100, ui::VKEY_F8, ui::DomKey::F8},
    {101, ui::VKEY_F9, ui::DomKey::F9},
    {109, ui::VKEY_F10, ui::DomKey::F10},
    {103, ui::VKEY_F11, ui::DomKey::F11},
    {111, ui::VKEY_F12, ui::DomKey::F12},
};

void AddKey(std::vector<DevKeyStep>& steps,
            ui::KeyboardCode key,
            ui::DomKey dom_key,
            int flags) {
  const ui::DomCode code = ui::UsLayoutKeyboardCodeToDomCode(key);
  steps.push_back({ui::EventType::kKeyPressed, key, code, dom_key, flags});
  steps.push_back({ui::EventType::kKeyReleased, key, code, dom_key, flags});
}

void AddCharacter(std::vector<DevKeyStep>& steps, char16_t c, int flags) {
  ui::KeyboardCode key = ui::VKEY_UNKNOWN;
  if (c >= u'a' && c <= u'z') {
    key = static_cast<ui::KeyboardCode>(ui::VKEY_A + (c - u'a'));
  } else if (c >= u'A' && c <= u'Z') {
    key = static_cast<ui::KeyboardCode>(ui::VKEY_A + (c - u'A'));
    flags |= ui::EF_SHIFT_DOWN;
  } else if (c >= u'0' && c <= u'9') {
    key = static_cast<ui::KeyboardCode>(ui::VKEY_0 + (c - u'0'));
  } else if (c == u' ') {
    key = ui::VKEY_SPACE;
  }
  AddKey(steps, key, ui::DomKey::FromCharacter(c), flags);
}

std::optional<std::vector<DevKeyStep>> ParseKeys(std::string_view spec) {
  const auto parts = Split(spec, ":");
  int64_t mac_flags = 0;
  int mac_code = -1;
  if (parts.size() < 2 || parts.size() > 3 ||
      !base::StringToInt64(parts[0], &mac_flags) || mac_flags < 0 ||
      (parts.size() == 3 && !base::StringToInt(parts[2], &mac_code))) {
    return std::nullopt;
  }
  int flags = 0;
  if (mac_flags & kNSShift)
    flags |= ui::EF_SHIFT_DOWN;
  if (mac_flags & (kNSControl | kNSCommand))
    flags |= ui::EF_CONTROL_DOWN;
  if (mac_flags & kNSOption)
    flags |= ui::EF_ALT_DOWN;
  std::vector<DevKeyStep> steps;
  // A key with no character of its own goes by its macOS key code.
  for (const auto& named : kNamedKeys) {
    if (named.mac_code == mac_code) {
      AddKey(steps, named.key, named.dom_key, flags);
      return steps;
    }
  }
  const std::u16string characters = base::UTF8ToUTF16(parts[1]);
  if (characters.size() != 1)
    return std::nullopt;
  AddCharacter(steps, characters[0], flags);
  return steps;
}

std::optional<std::vector<DevKeyStep>> ParseType(std::string_view text) {
  std::vector<DevKeyStep> steps;
  for (const char16_t c : base::UTF8ToUTF16(text))
    AddCharacter(steps, c, 0);
  if (steps.empty())
    return std::nullopt;
  return steps;
}

}  // namespace

std::optional<gfx::PointF> ParseDevPoint(std::string_view spec) {
  const auto parts = Split(spec, ",");
  double x = 0;
  double y = 0;
  if (parts.size() < 2 || !base::StringToDouble(parts[0], &x) ||
      !base::StringToDouble(parts[1], &y) || !std::isfinite(x) ||
      !std::isfinite(y) || std::abs(x) > kMaxCoordinate ||
      std::abs(y) > kMaxCoordinate) {
    return std::nullopt;
  }
  return gfx::PointF(static_cast<float>(x), static_cast<float>(y));
}

std::optional<std::vector<DevMouseStep>> ParseDevMouseAction(
    std::string_view action) {
  if (action.starts_with("click:"))
    return ParseClick(action.substr(6));
  if (action.starts_with("mouse:"))
    return ParseOne(action.substr(6));
  if (action.starts_with("drag:"))
    return ParseDrag(action.substr(5));
  return std::nullopt;
}

std::optional<std::vector<DevKeyStep>> ParseDevKeyAction(
    std::string_view action) {
  if (action.starts_with("keys:"))
    return ParseKeys(action.substr(5));
  if (action.starts_with("type:"))
    return ParseType(action.substr(5));
  return std::nullopt;
}

void SendDevMouse(aura::WindowTreeHost* host, const DevMouseStep& step) {
  gfx::PointF point = step.point;
  host->ConvertDIPToPixels(&point);
  ui::MouseEvent event(step.type, point, point, base::TimeTicks::Now(),
                       step.flags, step.changed_flags);
  if (step.click_count)
    event.SetClickCount(step.click_count);
  std::ignore = host->SendEventToSink(&event);
}

void SendDevKey(aura::WindowTreeHost* host, const DevKeyStep& step) {
  ui::KeyEvent event(step.type, step.key, step.code, step.flags, step.dom_key,
                     base::TimeTicks::Now());
  std::ignore = host->SendEventToSink(&event);
}

}  // namespace bay
