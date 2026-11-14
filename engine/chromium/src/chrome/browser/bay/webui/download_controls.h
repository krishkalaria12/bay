// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DOWNLOAD_CONTROLS_H_
#define CHROME_BROWSER_BAY_WEBUI_DOWNLOAD_CONTROLS_H_

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_manager_observer.h"

class Profile;

namespace bay {

// Downloads on the web desktop host, as NNCoreServices does them on macOS.
// The engine (nn_downloads.h) reports a profile's downloads only once
// nn_downloads_list has run for it, and that first call also turns Chrome's
// "Ask where to save each file" default off, so every Bay profile is listed as
// it loads. Controls go to the profile that reported the download; one this
// session hasn't seen (an earlier session's interrupted download) is looked
// for in each loaded profile.
class DownloadControls : public ProfileManagerObserver {
 public:
  // A download as BayCEF.onDownload carries it: the engine's, plus "profile".
  using Sink = base::RepeatingCallback<void(base::DictValue download)>;
  // An engine call: name, Bay profile id, arguments; replies a wire envelope.
  using Response = base::OnceCallback<void(const std::string&)>;
  using EngineInvoker = base::RepeatingCallback<
      void(const std::string&, const std::string&, base::DictValue, Response)>;

  static DownloadControls& Get();

  DownloadControls(const DownloadControls&) = delete;
  DownloadControls& operator=(const DownloadControls&) = delete;

  // Lists every loaded Bay profile now and each one that loads later, sending
  // what each holds to |sink|. Later calls only replace the sink.
  void Start(Sink sink);

  // The engine's "downloads.changed" payload for |profile| (a Bay profile id),
  // as the sink gets it. Remembers which profile the download is in.
  base::DictValue Adopt(const base::DictValue& download,
                        const std::string& profile);
  // The engine's "downloads.removed": the id is no longer Chrome's.
  void Forget(const std::string& id);

  // BayCEF.listDownloads: every loaded profile's downloads, newest first.
  void List(const EngineInvoker& engine, Response response);
  // BayCEF.pauseDownload, resumeDownload, cancelDownload. |command| is
  // "pause", "resume" or "cancel". Replies success, as macOS does, once the
  // engine has answered: an unknown or finished download is no error.
  void Command(const EngineInvoker& engine,
               const std::string& command,
               const std::string& id,
               Response response);

  // The Bay profile id of a loaded profile ("" for Default), or nullopt for
  // one that isn't a Bay profile (private, system, guest, elsewhere on disk).
  static std::optional<std::string> ProfileId(Profile* profile);
  // Ids of the loaded Bay profiles, Default first.
  static std::vector<std::string> LoadedProfiles();
  // Downloads from nn_downloads_list's |result| for |profile|, adopted.
  std::vector<base::DictValue> Downloads(const base::Value& result,
                                         const std::string& profile);
  // nn_downloads_list's raw reply for a profile Start() or a load watched.
  void Listed(const std::string& profile, const std::string& json);

 private:
  friend class base::NoDestructor<DownloadControls>;
  DownloadControls();
  ~DownloadControls() override;

  // ProfileManagerObserver
  void OnProfileAdded(Profile* profile) override;
  void OnProfileManagerDestroying() override;

  void Watch(const std::string& profile);
  void Try(EngineInvoker engine,
           std::string name,
           std::string id,
           std::vector<std::string> profiles,
           size_t index,
           Response response);
  // The engine's answer from profiles[index]: done, or the next profile.
  // (The controls live for the process: Try binds them unretained.)
  void Tried(EngineInvoker engine,
             std::string name,
             std::string id,
             std::vector<std::string> profiles,
             size_t index,
             Response response,
             const std::string& envelope);

  Sink sink_;
  bool started_ = false;
  // Download id (Chrome's GUID, unique across profiles) -> Bay profile id.
  std::map<std::string, std::string> profiles_;
  base::ScopedObservation<ProfileManager, ProfileManagerObserver>
      observation_{this};
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_DOWNLOAD_CONTROLS_H_
