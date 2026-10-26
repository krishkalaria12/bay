// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/pip/nn_pip_platform.h"

#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/values.h"
#include "chrome/common/chrome_paths.h"
#include "ui/aura/window.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/scoped_layer_animation_settings.h"

namespace {
std::optional<base::FilePath> BoundsFile() {
  base::FilePath dir;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &dir)) return std::nullopt;
  return dir.AppendASCII("BayPictureInPicture.json");
}
}  // namespace

std::optional<gfx::Rect> LoadBayPictureInPictureBounds() {
  const auto path = BoundsFile();
  std::string json;
  if (!path || !base::ReadFileToString(*path, &json)) return std::nullopt;
  auto values = base::JSONReader::ReadDict(json);
  if (!values) return std::nullopt;
  auto x = values->FindInt("x");
  auto y = values->FindInt("y");
  auto width = values->FindInt("width");
  auto height = values->FindInt("height");
  if (!x || !y || !width || !height || *width <= 0 || *height <= 0) return std::nullopt;
  return gfx::Rect(*x, *y, *width, *height);
}

void SaveBayPictureInPictureBounds(const gfx::Rect& bounds) {
  const auto path = BoundsFile();
  if (!path || bounds.IsEmpty()) return;
  auto json = base::WriteJson(base::DictValue().Set("x", bounds.x()).Set("y", bounds.y())
                                 .Set("width", bounds.width()).Set("height", bounds.height()));
  if (json) base::ImportantFileWriter::WriteFileAtomically(*path, *json);
}

void FadeOutBayPictureInPicture(gfx::NativeWindow window, base::TimeDelta duration) {
  if (!window || !window->layer()) return;
  ui::ScopedLayerAnimationSettings animation(window->layer()->GetAnimator());
  animation.SetTransitionDuration(duration);
  animation.SetTweenType(gfx::Tween::EASE_OUT);
  window->layer()->SetOpacity(0.f);
}

void ResetBayPictureInPictureFade(gfx::NativeWindow window) {
  if (!window || !window->layer()) return;
  window->layer()->GetAnimator()->StopAnimating();
  window->layer()->SetOpacity(1.f);
}

void NotifyBayPictureInPictureControls(gfx::NativeWindow window,
                                       bool visible,
                                       bool animate) {
  // Windows uses Chrome's own controls; there is no separate host overlay.
}
