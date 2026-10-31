// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PLATFORM_SERVICES_WIN_H_
#define CHROME_BROWSER_BAY_WEBUI_PLATFORM_SERVICES_WIN_H_

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/default_browser.h"
#include "chrome/browser/bay/webui/document_store.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/shell_files.h"

class BrowserWindowInterface;
namespace bay {
class ShellUI;

// UI-sequence owner. Blocking disk/registry/credential work runs on
// disk_runner_.
class PlatformServices {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  PlatformServices(HostContext context,
                   base::RepeatingClosure snapshots_changed);
  ~PlatformServices();
  PlatformServices(const PlatformServices&) = delete;
  PlatformServices& operator=(const PlatformServices&) = delete;

  void Prepare(base::OnceClosure ready);
  bool DispatchPlatformModule(const std::string& module,
                              const std::string& method,
                              const base::ListValue& args,
                              Response& callback);
  base::DictValue Snapshots() const;
  base::ListValue Modules() const;
  base::ListValue SupportedMethods() const;
  const std::string& initialization_error() const {
    return initialization_error_;
  }

 private:
  void Prepared(base::DictValue snapshots);
  void FilesReady();
  void DocumentsReady();

  const HostContext context_;
  base::RepeatingClosure snapshots_changed_;
  scoped_refptr<base::SequencedTaskRunner> disk_runner_;
  DocumentStore documents_;
  DefaultBrowser default_browser_;
  ShellFiles files_;
  base::DictValue snapshots_;
  std::string initialization_error_;
  bool preparing_ = false;
  bool ready_ = false;
  std::vector<base::OnceClosure> ready_callbacks_;
  std::unique_ptr<ShellUI> shell_ui_;
  base::WeakPtrFactory<PlatformServices> weak_factory_{this};
};
}  // namespace bay
#endif
