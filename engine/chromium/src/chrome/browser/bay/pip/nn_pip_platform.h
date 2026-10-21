// Copyright 2026 Bay. Apache-2.0.
//
// Platform storage and window fade for Bay's video Picture in Picture window.

#ifndef CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_
#define CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_

#include <optional>

#include "base/time/time.h"
#include "build/build_config.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"

#if BUILDFLAG(IS_LINUX)
#include "base/files/file_path.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/task/sequenced_task_runner.h"
#endif

// Saved screen DIPs live in BayPictureInPicture.plist on macOS or
// BayPictureInPicture.json on Aura, in the user data directory. Linux skips
// persistence when Ozone cannot supply global coordinates, including Wayland.
// Linux loads from a UI cache: until the startup preload completes, Load
// returns no saved bounds. An already opened window is never moved by the
// preload.
std::optional<gfx::Rect> LoadBayPictureInPictureBounds();
void SaveBayPictureInPictureBounds(const gfx::Rect& bounds);

#if BUILDFLAG(IS_LINUX)
// Call on UI during desktop startup, after Ozone and the thread pool are ready.
void InitializeBayPictureInPictureBounds();
#endif

// Fades the window's content out using the platform compositor while the tab
// it goes back to is being shown. Reset puts it back before the window shows.
void FadeOutBayPictureInPicture(gfx::NativeWindow window,
                                base::TimeDelta duration);
void ResetBayPictureInPictureFade(gfx::NativeWindow window);

#if BUILDFLAG(IS_LINUX)

namespace bay {

// UI-owned Linux persistence. Each instance uses one file and one ordered I/O
// sequence. Exposed here so tests can use isolated files without global state.
class PictureInPictureBoundsStore {
 public:
  PictureInPictureBoundsStore(base::FilePath path,
                              bool supports_global_screen_coordinates);
  ~PictureInPictureBoundsStore();

  std::optional<gfx::Rect> Load() const;
  void Save(const gfx::Rect& bounds);

 private:
  void OnLoaded(std::optional<gfx::Rect> bounds);

  const base::FilePath path_;
  const scoped_refptr<base::SequencedTaskRunner> io_runner_;
  std::optional<gfx::Rect> bounds_;
  bool has_saved_bounds_ = false;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<PictureInPictureBoundsStore> weak_factory_{this};
};

}  // namespace bay
#endif

#endif  // CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_
