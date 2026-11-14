// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/auto_picture_in_picture.h"

#include "chrome/browser/bay/webui/download_controls.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"

namespace bay {

AutoPictureInPicture& AutoPictureInPicture::Get() {
  static base::NoDestructor<AutoPictureInPicture> setting;
  return *setting;
}

AutoPictureInPicture::AutoPictureInPicture() = default;
AutoPictureInPicture::~AutoPictureInPicture() = default;

void AutoPictureInPicture::SetEnabled(bool enabled) {
  enabled_ = enabled;
  auto* manager =
      g_browser_process ? g_browser_process->profile_manager() : nullptr;
  if (!manager)
    return;
  if (!observation_.IsObserving())
    observation_.Observe(manager);
  for (Profile* profile : manager->GetLoadedProfiles())
    Apply(profile);
}

void AutoPictureInPicture::Apply(Profile* profile) const {
  if (!DownloadControls::ProfileId(profile))
    return;
  HostContentSettingsMapFactory::GetForProfile(profile)
      ->SetDefaultContentSetting(
          ContentSettingsType::AUTO_PICTURE_IN_PICTURE,
          enabled_ ? CONTENT_SETTING_ALLOW : CONTENT_SETTING_BLOCK);
}

void AutoPictureInPicture::OnProfileAdded(Profile* profile) {
  Apply(profile);
}

void AutoPictureInPicture::OnProfileManagerDestroying() {
  observation_.Reset();
}

}  // namespace bay
