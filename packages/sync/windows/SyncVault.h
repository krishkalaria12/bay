#pragma once
#include "SyncCrypto.h"
#include <set>
namespace bay::sync {
struct Listing {
  struct File {
    std::string id;
    Bytes payload;
  };
  struct Damaged {
    std::string id;
    double age;
  };
  std::vector<File> files;
  std::vector<std::string> pending, present;
  std::vector<Damaged> damaged;
};
class Vault {
public:
  Vault(std::filesystem::path folder, const Keys &keys)
      : folder_(std::move(folder)), keys_(keys) {}
  std::filesystem::path chainPath() const;
  bool chainExists() const;
  void createChain() const;
  std::string write(const std::string &scope, const Bytes &payload) const;
  Listing read(const std::string &scope,
               const std::set<std::string> &known) const;
  void remove(const std::string &scope,
              const std::vector<std::string> &ids) const;
  void deleteChain() const;

private:
  std::filesystem::path folder_;
  const Keys &keys_;
  std::filesystem::path scopePath(const std::string &scope) const;
};
} // namespace bay::sync
