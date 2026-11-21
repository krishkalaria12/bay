// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_UPDATER_SERVICE_WIN_H_
#define CHROME_BROWSER_BAY_WEBUI_UPDATER_SERVICE_WIN_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "chrome/browser/ui/simple_message_box.h"

class BrowserWindowInterface;

namespace bay {
struct UpdaterInitialization;
struct UpdaterCommandResult;

// One application-lifetime instance on the UI sequence. No renderer-supplied
// path, URL, policy, mode or installer is accepted by this service.
class UpdaterService {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using EventSink = base::RepeatingCallback<void(base::DictValue)>;

  UpdaterService(EventSink events, base::RepeatingClosure request_quit);
  ~UpdaterService();
  UpdaterService(const UpdaterService&) = delete;
  UpdaterService& operator=(const UpdaterService&) = delete;

  void Prepare(base::OnceClosure ready);
  bool Dispatch(BrowserWindowInterface* browser,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);
  base::DictValue State() const;

  // Run before normal application shutdown, while the UI task runner is alive.
  // A staged update starts an independent verified worker that waits for this
  // exact process to exit. Calling this does not download or relaunch Bay.
  void PrepareForQuit(base::OnceCallback<void(bool)> continuation);
  // A beforeunload/download prompt rejected shutdown. Stop any waiting update
  // worker through its cancellation marker and discard the old quit callback.
  void CancelQuit();

 private:
  enum class Operation { kCheck, kStage, kInstall, kDeferredInstall };
  void Prepared(UpdaterInitialization initial);
  void Start(Operation operation, bool manual, Response callback);
  void Completed(Operation operation,
                 bool manual,
                 uint64_t quit_generation,
                 Response callback,
                 UpdaterCommandResult result);
  void CancelWorker(const base::FilePath& path);
  void WorkerCancelled(const base::FilePath& path, bool success);
  void QuitTimedOut();
  void PromptForUpdate(const std::string& version);
  void PromptAnswered(chrome::MessageBoxResult answer);
  void AutomaticCheck();
  void ScheduleAutomaticCheck();
  void Publish();
  void SavePreferences(bool checks, bool downloads, Response callback);
  void PreferencesSaved(bool checks,
                        bool downloads,
                        Response callback,
                        bool success);
  void FinishQuit(bool success = true);

  EventSink events_;
  base::RepeatingClosure request_quit_;
  scoped_refptr<base::SequencedTaskRunner> worker_;
  base::FilePath executable_;
  base::FilePath powershell_;
  base::FilePath script_;
  base::FilePath settings_path_;
  base::FilePath cancel_path_;
  base::DictValue policy_;
  base::WeakPtr<BrowserWindowInterface> prompt_browser_;
  base::OneShotTimer check_timer_;
  base::OneShotTimer quit_deadline_;
  std::vector<base::OnceClosure> ready_callbacks_;
  std::vector<base::OnceCallback<void(bool)>> quit_callbacks_;
  bool preparing_ = false;
  bool ready_ = false;
  bool configured_ = false;
  bool automatic_checks_ = true;
  bool automatic_downloads_ = false;
  bool busy_ = false;
  bool prompting_ = false;
  bool staged_ = false;
  bool installing_ = false;
  bool quitting_ = false;
  bool quit_preparation_pending_ = false;
  bool install_in_flight_ = false;
  bool cancelling_worker_ = false;
  uint64_t quit_generation_ = 0;
  std::optional<double> last_check_;
  std::string status_ = "initializing";
  std::string pending_version_;
  std::string error_;
  base::WeakPtrFactory<UpdaterService> weak_factory_{this};
};
}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_UPDATER_SERVICE_WIN_H_
