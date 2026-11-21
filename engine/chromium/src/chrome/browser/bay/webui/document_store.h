// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DOCUMENT_STORE_H_
#define CHROME_BROWSER_BAY_WEBUI_DOCUMENT_STORE_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"

namespace bay {

// Names that are safe as a single file on every desktop, including Windows'
// reserved device names, so a document written on one platform reads on all.
bool IsValidDocumentName(std::string_view name);

// The app's documents (BayShell.readDocument and friends) for one host. Each
// store reads the folder once before its host answers, and a successful write
// updates every store on the same folder. Blocking work runs on one sequence
// shared by all stores, so writes land in the order they were made.
class DocumentStore {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  // <user data>/BayDocuments.
  static base::FilePath DefaultDirectory();
  static base::ListValue SupportedMethods();

  // `changed` runs after any store's write changes documents().
  DocumentStore(base::FilePath directory, base::RepeatingClosure changed);
  ~DocumentStore();
  DocumentStore(const DocumentStore&) = delete;
  DocumentStore& operator=(const DocumentStore&) = delete;

  void Prepare(base::OnceClosure ready);
  // Set when the folder or a document could not be read. The store then
  // refuses every method rather than risk overwriting what it couldn't read.
  const std::string& error() const { return error_; }
  base::DictValue documents() const { return documents_.Clone(); }

  // False leaves callback untouched.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  struct Contents {
    base::DictValue documents;
    std::string error;
  };
  static Contents Read(base::FilePath directory);
  static bool Write(base::FilePath path, std::optional<std::string> contents);
  static void Written(base::FilePath directory,
                      std::string name,
                      std::optional<std::string> contents,
                      Response callback,
                      bool success);
  void Loaded(Contents contents);
  void Apply(std::string_view name, const std::optional<std::string>& contents);

  const base::FilePath directory_;
  base::RepeatingClosure changed_;
  base::DictValue documents_;
  std::string error_;
  bool preparing_ = false;
  bool ready_ = false;
  std::vector<base::OnceClosure> ready_callbacks_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<DocumentStore> weak_factory_{this};
};

}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_DOCUMENT_STORE_H_
