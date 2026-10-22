// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_FILES_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_FILES_H_

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"

namespace bay {
// Document-owned UI-sequence service. Callers retain their profile, readiness
// and contract-arity gates. Workers receive paths and callbacks, never
// profiles.
class ShellFiles {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  // External-effect seams. Open/reveal run on UI; trash runs on a MayBlock
  // sequence (COM STA on Windows). Empty callbacks select the native backend.
  struct Operations {
    base::RepeatingCallback<void(Profile*,
                                 const base::FilePath&,
                                 bool,
                                 base::OnceCallback<void(bool)>)>
        open;
    base::RepeatingCallback<void(Profile*, const base::FilePath&)> reveal;
    base::RepeatingCallback<bool(const base::FilePath&)> trash;
  };
  explicit ShellFiles(HostContext context);
  ShellFiles(HostContext context, Operations operations);
  ~ShellFiles();
  ShellFiles(const ShellFiles&) = delete;
  ShellFiles& operator=(const ShellFiles&) = delete;

  static base::ListValue SupportedMethods();
  void Prepare(base::OnceClosure ready);
  bool ready() const { return ready_; }
  base::Value downloads_folder() const { return downloads_folder_.Clone(); }
  // Unhandled methods leave callback untouched. Valid requests settle exactly
  // once, including owner teardown. Accepted external work may outlive owner.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  enum class ItemType { kUnavailable, kFile, kDirectory };
  static ItemType Classify(const base::FilePath& path);
  void Prepared(base::Value downloads_folder);
  void Open(uint64_t request, base::FilePath path, ItemType type);
  void Reveal(uint64_t request, base::FilePath path, ItemType type);
  void Complete(uint64_t request, bool result);
  // Answers and forgets a pending request.
  void Settle(uint64_t request, std::string response);

  const HostContext context_;
  Operations operations_;
  base::Value downloads_folder_;
  bool preparing_ = false;
  bool ready_ = false;
  uint64_t next_request_ = 0;
  std::map<uint64_t, Response> pending_;
  std::vector<base::OnceClosure> ready_callbacks_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<ShellFiles> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_SHELL_FILES_H_
