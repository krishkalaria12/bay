// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_USER_SCRIPTS_H_
#define CHROME_BROWSER_BAY_WEBUI_USER_SCRIPTS_H_

#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/threading/sequence_bound.h"
#include "base/values.h"

namespace base {
class SequencedTaskRunner;
}
namespace bay {

// The CLI publishes a generation under a shared OS lock. Watch notifications
// only ask the coordinator to reconcile; read() takes the lock and validates
// the published content-script extension before exposing its path.
class UserScripts {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  static base::FilePath DefaultDirectory();
  static base::ListValue SupportedMethods();

  UserScripts(base::FilePath directory, base::RepeatingClosure changed);
  ~UserScripts();
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& response);

  // Blocking operations, exposed for the native filesystem tests.
  static base::DictValue Read(const base::FilePath& directory);
  static base::Value ReadStatus(const base::FilePath& directory);
  static bool WriteStatus(const base::FilePath& directory,
                          const std::string& json);

 private:
  class Watcher;
  const base::FilePath directory_;
  const scoped_refptr<base::SequencedTaskRunner> disk_;
  base::SequenceBound<Watcher> watcher_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_USER_SCRIPTS_H_
