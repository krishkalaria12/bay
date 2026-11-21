// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_AUTO_PICTURE_IN_PICTURE_H_
#define CHROME_BROWSER_BAY_WEBUI_AUTO_PICTURE_IN_PICTURE_H_

#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_manager_observer.h"

class Profile;

namespace bay {

// Chrome's automatic Picture in Picture (a call's own document PiP on a tab
// switch) follows the app's setting, without Chrome's prompt, as macOS nncore's
// setAutoPictureInPicture: on every profile, and each one that loads later.
class AutoPictureInPicture : public ProfileManagerObserver {
 public:
  static AutoPictureInPicture& Get();

  AutoPictureInPicture(const AutoPictureInPicture&) = delete;
  AutoPictureInPicture& operator=(const AutoPictureInPicture&) = delete;

  void SetEnabled(bool enabled);

 private:
  friend class base::NoDestructor<AutoPictureInPicture>;
  AutoPictureInPicture();
  ~AutoPictureInPicture() override;

  void Apply(Profile* profile) const;

  // ProfileManagerObserver
  void OnProfileAdded(Profile* profile) override;
  void OnProfileManagerDestroying() override;

  bool enabled_ = true;
  base::ScopedObservation<ProfileManager, ProfileManagerObserver> observation_{
      this};
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_AUTO_PICTURE_IN_PICTURE_H_
