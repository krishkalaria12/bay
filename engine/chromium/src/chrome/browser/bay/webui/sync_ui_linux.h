// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SYNC_UI_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_SYNC_UI_LINUX_H_

#include <string>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"

namespace bay {
class HostContext;

// Owns the asynchronous folder/recovery export picker for one native host.
class SyncUI {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  SyncUI();
  ~SyncUI();
  SyncUI(const SyncUI&) = delete;
  SyncUI& operator=(const SyncUI&) = delete;

  bool Dispatch(const HostContext& context,
                const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  class FilePicker;
  void PickerFinished(FilePicker* picker);

  scoped_refptr<FilePicker> picker_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<SyncUI> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_SYNC_UI_LINUX_H_
