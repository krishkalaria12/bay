// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_EASEL_SHARING_H_
#define CHROME_BROWSER_BAY_WEBUI_EASEL_SHARING_H_

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/values.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"

class Profile;

namespace bay {

// Sharing uses the existing web publication flow. Only capability generation
// and the registry's first, failure-preserving read belong in the native host.
class EaselSharing {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  explicit EaselSharing(Profile* profile);
  // Directory is the same one BayShell.saveDocument writes to.
  explicit EaselSharing(
      base::FilePath directory, bool enabled,
      scoped_refptr<network::SharedURLLoaderFactory> factory = nullptr);
  ~EaselSharing();
  EaselSharing(const EaselSharing&) = delete;
  EaselSharing& operator=(const EaselSharing&) = delete;

  void Prepare(base::OnceClosure ready);
  bool ready() const { return ready_; }
  // A failed registry read omits its snapshot, so a synchronous read throws
  // instead of treating an unreadable registry as a new one.
  base::DictValue snapshots() const { return snapshots_.Clone(); }
  static base::ListValue SupportedMethods();
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  struct Request;
  void Prepared(base::DictValue result);
  void RequestShare(const base::ListValue& args, Response response);
  void Requested(int id, std::optional<std::string> body);
  const base::FilePath directory_;
  const bool enabled_;
  scoped_refptr<network::SharedURLLoaderFactory> factory_;
  int next_request_ = 0;
  std::map<int, std::unique_ptr<Request>> requests_;
  bool preparing_ = false;
  bool ready_ = false;
  base::DictValue snapshots_;
  std::vector<base::OnceClosure> ready_callbacks_;
  base::WeakPtrFactory<EaselSharing> weak_factory_{this};
};

}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_EASEL_SHARING_H_
