// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/pip/nn_pip_platform.h"

#include <utility>

#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/values.h"
#include "build/build_config.h"
#include "chrome/common/chrome_paths.h"
#include "ui/aura/window.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/scoped_layer_animation_settings.h"

#if BUILDFLAG(IS_LINUX)
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#endif
#if BUILDFLAG(IS_OZONE)
#include "ui/ozone/public/ozone_platform.h"
#endif

namespace {
std::optional<base::FilePath> BoundsFile() {
  base::FilePath dir;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &dir))
    return std::nullopt;
  return dir.AppendASCII("BayPictureInPicture.json");
}

std::optional<gfx::Rect> ReadBounds(const base::FilePath& path) {
  std::string json;
  if (!base::ReadFileToString(path, &json))
    return std::nullopt;
  auto values = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!values)
    return std::nullopt;
  auto x = values->FindInt("x");
  auto y = values->FindInt("y");
  auto width = values->FindInt("width");
  auto height = values->FindInt("height");
  if (!x || !y || !width || !height || *width <= 0 || *height <= 0)
    return std::nullopt;
  return gfx::Rect(*x, *y, *width, *height);
}

void WriteBounds(const base::FilePath& path, const gfx::Rect& bounds) {
  auto json = base::WriteJson(base::DictValue()
                                  .Set("x", bounds.x())
                                  .Set("y", bounds.y())
                                  .Set("width", bounds.width())
                                  .Set("height", bounds.height()));
  if (json)
    base::ImportantFileWriter::WriteFileAtomically(path, *json);
}

#if BUILDFLAG(IS_LINUX)
bool SupportsGlobalCoordinates() {
#if BUILDFLAG(IS_OZONE)
  return ui::OzonePlatform::GetInstance()
      ->GetPlatformProperties()
      .supports_global_screen_coordinates;
#else
  return true;
#endif
}

bay::PictureInPictureBoundsStore& LinuxBoundsStore() {
  static base::NoDestructor<bay::PictureInPictureBoundsStore> store(
      BoundsFile().value_or(base::FilePath()), SupportsGlobalCoordinates());
  return *store;
}
#endif
}  // namespace

#if BUILDFLAG(IS_LINUX)
namespace bay {

PictureInPictureBoundsStore::PictureInPictureBoundsStore(
    base::FilePath path,
    bool supports_global_screen_coordinates)
    : path_(std::move(path)),
      io_runner_(supports_global_screen_coordinates && !path_.empty()
                     ? base::ThreadPool::CreateSequencedTaskRunner(
                           {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                            base::TaskShutdownBehavior::BLOCK_SHUTDOWN})
                     : nullptr) {
  if (io_runner_) {
    io_runner_->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadBounds, path_),
        base::BindOnce(&PictureInPictureBoundsStore::OnLoaded,
                       weak_factory_.GetWeakPtr()));
  }
}

PictureInPictureBoundsStore::~PictureInPictureBoundsStore() = default;

std::optional<gfx::Rect> PictureInPictureBoundsStore::Load() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  return bounds_;
}

void PictureInPictureBoundsStore::Save(const gfx::Rect& bounds) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!io_runner_ || bounds.IsEmpty())
    return;
  has_saved_bounds_ = true;
  bounds_ = bounds;
  // Copy the path and bounds so writes survive the UI owner's destruction.
  io_runner_->PostTask(FROM_HERE, base::BindOnce(&WriteBounds, path_, bounds));
}

void PictureInPictureBoundsStore::OnLoaded(std::optional<gfx::Rect> bounds) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  // A window can move before the startup read replies. Its latest bounds win.
  if (!has_saved_bounds_)
    bounds_ = bounds;
}

}  // namespace bay

void InitializeBayPictureInPictureBounds() {
  LinuxBoundsStore();
}
#endif

std::optional<gfx::Rect> LoadBayPictureInPictureBounds() {
#if BUILDFLAG(IS_LINUX)
  return LinuxBoundsStore().Load();
#else
  const auto path = BoundsFile();
  return path ? ReadBounds(*path) : std::nullopt;
#endif
}

void SaveBayPictureInPictureBounds(const gfx::Rect& bounds) {
#if BUILDFLAG(IS_LINUX)
  LinuxBoundsStore().Save(bounds);
#else
  const auto path = BoundsFile();
  if (path && !bounds.IsEmpty())
    WriteBounds(*path, bounds);
#endif
}

void FadeOutBayPictureInPicture(gfx::NativeWindow window,
                                base::TimeDelta duration) {
  if (!window || !window->layer())
    return;
  ui::ScopedLayerAnimationSettings animation(window->layer()->GetAnimator());
  animation.SetTransitionDuration(duration);
  animation.SetTweenType(gfx::Tween::EASE_OUT);
  window->layer()->SetOpacity(0.f);
}

void ResetBayPictureInPictureFade(gfx::NativeWindow window) {
  if (!window || !window->layer())
    return;
  window->layer()->GetAnimator()->StopAnimating();
  window->layer()->SetOpacity(1.f);
}

void NotifyBayPictureInPictureControls(gfx::NativeWindow window,
                                       bool visible,
                                       bool animate) {
  // Aura hosts use Chrome's own controls; there is no separate host overlay.
}
