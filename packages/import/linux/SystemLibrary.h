#pragma once
#include "../windows/ImportCore.h"
#include <dlfcn.h>
#include <sys/stat.h>
namespace bay::importer::linux_secrets {
// Do not search the profile, cwd, PATH, or LD_LIBRARY_PATH for a top-level
// crypto/secret library. Follow distro symlinks, then verify its ancestry.
inline void *openSystemLibrary(std::initializer_list<const char *> paths) {
  for (auto path : paths) {
    std::error_code error;
    auto resolved = std::filesystem::canonical(path, error);
    if (error)
      continue;
    bool trusted = true;
    for (auto p = resolved; !p.empty(); p = p.parent_path()) {
      struct stat info{};
      if (stat(p.c_str(), &info) || info.st_uid != 0 ||
          (info.st_mode & (S_IWGRP | S_IWOTH))) {
        trusted = false;
        break;
      }
      if (p == p.root_path())
        break;
    }
    if (trusted)
      if (auto library = dlopen(resolved.c_str(), RTLD_NOW | RTLD_LOCAL))
        return library;
  }
  return nullptr;
}
} // namespace bay::importer::linux_secrets
