// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CLI_INSTALLER_H_
#define CHROME_BROWSER_BAY_WEBUI_CLI_INSTALLER_H_

#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"

namespace bay {
// Copies the standalone CLI shipped in the app. No downloaded script, shell,
// elevated process, or externally supplied executable is run by the installer.
// Disk operations must run on a sequenced MayBlock runner.
class CliInstaller {
 public:
  struct Paths {
    base::FilePath bundle;
    base::FilePath home;
    base::FilePath bin;
    bool isolated = false;
  };
  static Paths DefaultPaths();
  static base::Value InstalledVersion(const Paths& paths);
  static base::DictValue Install(
      const Paths& paths,
      base::RepeatingCallback<void(std::string)> on_line = {});
};

class CliInstallerService {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using EventSink = base::RepeatingCallback<
      void(const char*, const char*, base::DictValue)>;
  CliInstallerService(HostContext context,
                      EventSink events,
                      base::RepeatingClosure changed);
  ~CliInstallerService();
  void Prepare(base::OnceClosure ready);
  bool ready() const { return ready_; }
  base::DictValue Snapshot() const;
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& response);

 private:
  void Prepared(base::OnceClosure ready, base::Value version);
  void InstallLine(std::string line);
  void Installed(Response response, base::DictValue result);
  void InstallationChanged(base::Value version);
  const HostContext context_;
  EventSink events_;
  base::RepeatingClosure changed_;
  bool ready_ = false;
  base::Value installed_version_;
  base::WeakPtrFactory<CliInstallerService> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_CLI_INSTALLER_H_
