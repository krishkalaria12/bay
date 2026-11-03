// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_INPUT_H_
#define CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_INPUT_H_

#include <optional>
#include <string_view>
#include <vector>

#include "base/time/time.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/dom/dom_code.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/events/types/event_type.h"
#include "ui/gfx/geometry/point_f.h"

namespace aura {
class WindowTreeHost;
}

namespace bay {

// The test scripts' input actions, spelled as on macOS (NNChromeWindowHost):
//   click:<x>,<y>[,right]                        press and release
//   mouse:<down|up|dragged|moved>:<x>,<y>[,<n>]  one left-button event
//   drag:<x>,<y>;<x>,<y>[;...]                   press, 12 moves a leg, release
//   keys:<NSEvent flags>:<character>[:<keyCode>] one key
//   type:<text>                                  each character as a key
// Points are in the window's coordinates, from its top left. Command and
// Control both become Control, the desktop's primary modifier.
struct DevMouseStep {
  ui::EventType type;
  gfx::PointF point;
  int flags = 0;
  int changed_flags = 0;
  int click_count = 0;
  base::TimeDelta delay;
};
struct DevKeyStep {
  ui::EventType type;
  ui::KeyboardCode key;
  ui::DomCode code;
  ui::DomKey dom_key;
  int flags = 0;
};

// nullopt when |action| isn't a well-formed action of that kind.
std::optional<std::vector<DevMouseStep>> ParseDevMouseAction(
    std::string_view action);
std::optional<std::vector<DevKeyStep>> ParseDevKeyAction(
    std::string_view action);
// "x,y[,...]": the point it starts with.
std::optional<gfx::PointF> ParseDevPoint(std::string_view spec);

// Through the host's event sink, as the platform delivers events: they reach
// embedded pages and the input method as real input does.
void SendDevMouse(aura::WindowTreeHost* host, const DevMouseStep& step);
void SendDevKey(aura::WindowTreeHost* host, const DevKeyStep& step);

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_DEV_WINDOW_INPUT_H_
