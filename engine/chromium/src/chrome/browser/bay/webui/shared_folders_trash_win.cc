// Copyright 2026 Bay. Apache-2.0.

#include <windows.h>

#include <shellapi.h>

#include <string>

#include "chrome/browser/bay/webui/shared_folders.h"

namespace bay {

bool MoveToTrash(const base::FilePath& path) {
  // Double-NUL-terminated, as SHFileOperation's list of names is.
  std::wstring from = path.value();
  from.push_back(L'\0');
  SHFILEOPSTRUCTW operation = {};
  operation.wFunc = FO_DELETE;
  operation.pFrom = from.c_str();
  operation.fFlags = static_cast<FILEOP_FLAGS>(
      FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT);
  return SHFileOperationW(&operation) == 0 &&
         !operation.fAnyOperationsAborted &&
         GetFileAttributesW(path.value().c_str()) == INVALID_FILE_ATTRIBUTES;
}

}  // namespace bay
