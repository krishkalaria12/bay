// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/library_files.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/uuid.h"
#include "chrome/common/chrome_paths.h"

namespace bay {
namespace {

constexpr size_t kMaximumImageBytes = 64 * 1024 * 1024;
constexpr size_t kMaximumNameLength = 120;
constexpr char kCacheFolder[] = "cache";
constexpr std::string_view kUnsafeNameCharacters = "/\\:*?\"<>|";
constexpr base::TimeDelta kCacheAge = base::Days(1);
constexpr std::array<uint8_t, 8> kPngSignature = {0x89, 'P',  'N',  'G',
                                                  0x0D, 0x0A, 0x1A, 0x0A};

std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}

std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set("error", base::DictValue()
                                                .Set("code", code)
                                                .Set("message", message)))
      .value_or("{}");
}

std::string InvalidArguments() {
  return Failure("invalid_args", "Invalid native method arguments");
}

base::FilePath MediaDirectory() {
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return {};
  return root.AppendASCII("Library Media");
}

bool IsPng(std::string_view bytes) {
  return bytes.size() > 24 &&
         std::ranges::equal(base::as_byte_span(bytes).first(kPngSignature.size()),
                            base::as_byte_span(kPngSignature));
}

// Big-endian, from the IHDR chunk right after the signature.
int PngDimension(std::string_view bytes, size_t offset) {
  const auto byte = [&](size_t i) {
    return static_cast<uint32_t>(static_cast<uint8_t>(bytes[offset + i]));
  };
  const uint32_t value =
      byte(0) << 24 | byte(1) << 16 | byte(2) << 8 | byte(3);
  return value > 1'000'000 ? 0 : static_cast<int>(value);
}

void RemoveOldCaptures(const base::FilePath& cache) {
  const base::Time oldest = base::Time::Now() - kCacheAge;
  base::FileEnumerator files(cache, false, base::FileEnumerator::FILES,
                             FILE_PATH_LITERAL("*.png"));
  for (auto file = files.Next(); !file.empty(); file = files.Next()) {
    if (files.GetInfo().GetLastModifiedTime() < oldest)
      base::DeleteFile(file);
  }
}

// Writes a new PNG, named here so a caller can't choose where it lands.
std::optional<base::FilePath> WritePng(std::string_view bytes, bool cache) {
  auto directory = MediaDirectory();
  if (directory.empty() || !IsPng(bytes))
    return std::nullopt;
  if (cache)
    directory = directory.AppendASCII(kCacheFolder);
  if (!base::CreateDirectory(directory))
    return std::nullopt;
  if (cache)
    RemoveOldCaptures(directory);
  const auto file = directory.AppendASCII(
      base::Uuid::GenerateRandomV4().AsLowercaseString() + ".png");
  if (!base::WriteFile(file, bytes)) {
    base::DeleteFile(file);
    return std::nullopt;
  }
  return file;
}

std::optional<base::DictValue> StoreCaptureOnWorker(std::string base64) {
  std::string bytes;
  if (!base::Base64Decode(base64, &bytes))
    return std::nullopt;
  const auto file = WritePng(bytes, true);
  if (!file)
    return std::nullopt;
  return base::DictValue()
      .Set("path", file->AsUTF8Unsafe())
      .Set("width", PngDimension(bytes, 16))
      .Set("height", PngDimension(bytes, 20));
}

std::string StoreImage(std::string base64, bool cache) {
  std::string bytes;
  if (!base::Base64Decode(base64, &bytes))
    return InvalidArguments();
  const auto file = WritePng(bytes, cache);
  return file ? Success(base::Value(file->AsUTF8Unsafe())) : Success();
}

bool IsImageFile(const base::FilePath& file) {
  const auto extension = base::ToLowerASCII(file.FinalExtension());
  for (const auto* known :
       {FILE_PATH_LITERAL(".png"), FILE_PATH_LITERAL(".jpg"),
        FILE_PATH_LITERAL(".jpeg"), FILE_PATH_LITERAL(".gif"),
        FILE_PATH_LITERAL(".webp"), FILE_PATH_LITERAL(".bmp"),
        FILE_PATH_LITERAL(".avif"), FILE_PATH_LITERAL(".ico"),
        FILE_PATH_LITERAL(".svg")}) {
    if (extension == known)
      return true;
  }
  return false;
}

std::string ReadImage(base::FilePath file) {
  std::string bytes;
  if (!file.IsAbsolute() || !IsImageFile(file) ||
      !base::ReadFileToStringWithMaxSize(file, &bytes, kMaximumImageBytes)) {
    return Success();
  }
  return Success(base::Value(base::Base64Encode(bytes)));
}

// Only a PNG directly in the media folder: never the folder, the cache, or a
// link's target outside it.
std::string RemoveImage(base::FilePath file) {
  base::FilePath directory;
  base::FilePath real;
  const bool inside =
      base::NormalizeFilePath(MediaDirectory(), &directory) &&
      base::NormalizeFilePath(file, &real) && real.DirName() == directory &&
      base::ToLowerASCII(real.FinalExtension()) == FILE_PATH_LITERAL(".png");
  return Success(base::Value(inside && base::DeleteFile(real)));
}

std::string ImageExists(base::FilePath file) {
  return Success(base::Value(file.IsAbsolute() && base::PathExists(file)));
}

// A file name on every desktop, from a page's title.
std::string SafeFileName(std::string_view name) {
  std::string safe;
  for (const char c : name) {
    const auto byte = static_cast<unsigned char>(c);
    const bool unsafe = byte < 0x20 || kUnsafeNameCharacters.find(c) !=
                                           std::string_view::npos;
    safe.push_back(unsafe ? '-' : c);
  }
  base::TrimString(safe, " .", &safe);
  if (safe.size() > kMaximumNameLength) {
    base::TruncateUTF8ToByteSize(safe, kMaximumNameLength, &safe);
    base::TrimString(safe, " .", &safe);
  }
  return safe.empty() ? "Bay" : safe;
}

// In Downloads, numbered when the name is taken: its path.
std::string SaveDownload(std::string base64,
                         std::string name,
                         std::string extension) {
  std::string bytes;
  if (!base::Base64Decode(base64, &bytes) ||
      (extension != "png" && extension != "html")) {
    return InvalidArguments();
  }
  base::FilePath folder;
  if (!base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &folder) ||
      !base::CreateDirectory(folder)) {
    return Success();
  }
  const auto file = base::GetUniquePath(
      folder.Append(base::FilePath::FromUTF8Unsafe(SafeFileName(name)))
          .AddExtensionASCII(extension));
  if (file.empty() || !base::WriteFile(file, bytes))
    return Success();
  return Success(base::Value(file.AsUTF8Unsafe()));
}

bool IsGeneratedName(std::string_view name) {
  return name.size() > 4 && name.size() <= 64 && name.ends_with(".png") &&
         std::ranges::all_of(name.substr(0, name.size() - 4), [](char c) {
           return base::IsAsciiLower(c) || base::IsAsciiDigit(c) || c == '-';
         });
}

template <typename Task>
void Post(Task task, LibraryFiles::Response& callback) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::BLOCK_SHUTDOWN},
      std::move(task), std::move(callback));
}

}  // namespace

// static
base::ListValue LibraryFiles::SupportedMethods() {
  return base::ListValue()
      .Append("BayEasel.readImage")
      .Append("BayEasel.storeImage")
      .Append("BayEasel.saveDownload");
}

// static
bool LibraryFiles::Dispatch(const std::string& module,
                            const std::string& method,
                            const base::ListValue& args,
                            Response& callback) {
  if (module != "BayEasel" ||
      (method != "readImage" && method != "storeImage" &&
       method != "saveDownload" && method != "removeLibraryImage" &&
       method != "libraryImageExists")) {
    return false;
  }
  const auto text = [&](size_t index) -> const std::string* {
    return index < args.size() && args[index].is_string()
               ? &args[index].GetString()
               : nullptr;
  };
  const auto* first = text(0);
  if (!first) {
    std::move(callback).Run(InvalidArguments());
    return true;
  }
  if (method == "storeImage") {
    const bool cache =
        args.size() > 1 && args[1].is_bool() && args[1].GetBool();
    Post(base::BindOnce(&StoreImage, *first, cache), callback);
    return true;
  }
  if (method == "saveDownload") {
    const auto* name = text(1);
    const auto* extension = text(2);
    if (!name || !extension) {
      std::move(callback).Run(InvalidArguments());
      return true;
    }
    Post(base::BindOnce(&SaveDownload, *first, *name, *extension), callback);
    return true;
  }
  const auto file = base::FilePath::FromUTF8Unsafe(*first);
  if (method == "readImage")
    Post(base::BindOnce(&ReadImage, file), callback);
  else if (method == "removeLibraryImage")
    Post(base::BindOnce(&RemoveImage, file), callback);
  else
    Post(base::BindOnce(&ImageExists, file), callback);
  return true;
}

// static
void LibraryFiles::StoreCapture(std::string base64, StoredImage done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&StoreCaptureOnWorker, std::move(base64)),
      std::move(done));
}

// static
scoped_refptr<base::RefCountedMemory> LibraryFiles::ReadAsset(
    std::string_view relative) {
  auto file = MediaDirectory();
  const std::string_view prefix = "cache/";
  if (relative.starts_with(prefix)) {
    file = file.AppendASCII(kCacheFolder);
    relative.remove_prefix(prefix.size());
  }
  if (file.empty() || !IsGeneratedName(relative))
    return nullptr;
  std::string bytes;
  if (!base::ReadFileToStringWithMaxSize(file.AppendASCII(relative), &bytes,
                                         kMaximumImageBytes)) {
    return nullptr;
  }
  return base::MakeRefCounted<base::RefCountedString>(std::move(bytes));
}

}  // namespace bay
