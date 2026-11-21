#include "../windows/RecoveryKit.h"
#include "../windows/RecoveryKitInternal.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "base/files/file_path.h"
#include "base/strings/utf_string_conversions.h"
#include "ui/base/clipboard/file_info.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/font_list.h"
#include "ui/gfx/geometry/rect.h"

namespace bay::sync {
namespace {
void privateDirectory(const std::filesystem::path &path) {
  if (::mkdir(path.c_str(), 0700) != 0 && errno != EEXIST)
    throw Failure("recovery", "Could not create the recovery kit directory");
  struct stat status{};
  if (::lstat(path.c_str(), &status) != 0 || !S_ISDIR(status.st_mode) ||
      status.st_uid != ::geteuid() || ::chmod(path.c_str(), 0700) != 0)
    throw Failure("recovery", "Recovery kit directory is not private");
}
} // namespace

Bytes recoveryKitPreviewPNG(const Bytes &entropy, const std::string &device,
                            unsigned width) {
  width = std::clamp(width, 168u, 1224u);
  unsigned height = width * 792 / 612;
  gfx::Canvas image(gfx::Size(width, height), 1.0f, true);
  image.DrawColor(SK_ColorWHITE);
  auto x = [width](int value) { return value * static_cast<int>(width) / 612; };
  auto text = [&](const std::string &value, int left, int top, int size,
                  bool bold = false) {
    gfx::FontList font;
    font = font.Derive(
        std::max(1, x(size)) - font.GetFontSize(), gfx::Font::NORMAL,
        bold ? gfx::Font::Weight::BOLD : gfx::Font::Weight::NORMAL);
    image.DrawStringRect(
        base::UTF8ToUTF16(value), font, SkColorSetRGB(25, 25, 25),
        gfx::Rect(x(left), x(top), x(562 - left), x(size + 8)));
  };
  text("Bay Recovery Kit", 50, 48, 24, true);
  text("Created on " + device, 50, 80, 11);
  text("To recover on another computer:", 50, 118, 12);
  text("1. Open Bay > Settings > Sync. Choose the same folder.", 50, 145, 11);
  text("2. Click Enter Recovery Phrase.", 50, 166, 11);
  text("3. Enter these 24 words in order.", 50, 187, 11);
  auto words = recoveryWords(entropy);
  for (std::size_t i = 0; i < words.size(); ++i)
    text(std::to_string(i + 1) + ". " + words[i], 50 + (i / 6) * 127,
         240 + (i % 6) * 28, 12);
  text("Keep this kit private. Store it somewhere safe.", 50, 642, 11);
  text("Anyone with these words and the folder can read your data.", 50, 662,
       11);
  text("Bay cannot recover these words for you.", 50, 682, 11);
  auto bitmap = image.GetBitmap();
  Bytes pixels(static_cast<std::size_t>(width) * height * 3);
  for (unsigned row = 0; row < height; ++row) {
    for (unsigned col = 0; col < width; ++col) {
      auto color = bitmap.getColor(col, row);
      auto offset = (static_cast<std::size_t>(row) * width + col) * 3;
      pixels[offset] = SkColorGetR(color);
      pixels[offset + 1] = SkColorGetG(color);
      pixels[offset + 2] = SkColorGetB(color);
    }
  }
  auto scale = std::max(1u, static_cast<unsigned>(x(144)) /
                                (detail::recoveryQRSize(entropy) + 8));
  detail::drawRecoveryQR(pixels, width, height, entropy, x(50) + 4 * scale,
                         x(430) + 4 * scale, scale);
  auto png = detail::encodeRGBPNG(width, height, pixels);
  erase(pixels);
  bitmap.eraseColor(SK_ColorTRANSPARENT);
  return png;
}

std::filesystem::path
temporaryRecoveryKit(const Bytes &entropy, const std::string &device,
                     const std::filesystem::path &directory) {
  const auto root = directory / "Recovery Kits";
  privateDirectory(root);
  auto pattern = (root / "kit-XXXXXX").string();
  if (!::mkdtemp(pattern.data()))
    throw Failure("recovery", "Could not create the recovery kit directory");
  const std::filesystem::path folder(pattern);
  const auto file = folder / "Bay Recovery Kit.pdf";
  int descriptor = -1;
  std::string pdf;
  try {
    pdf = recoveryKitPDF(entropy, device);
    descriptor =
        ::open(file.c_str(),
               O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (descriptor < 0)
      throw Failure("recovery", "Could not write the recovery kit");
    std::size_t offset = 0;
    while (offset < pdf.size()) {
      auto written =
          ::write(descriptor, pdf.data() + offset, pdf.size() - offset);
      if (written < 0 && errno == EINTR)
        continue;
      if (written <= 0)
        throw Failure("recovery", "Could not write the recovery kit");
      offset += written;
    }
    auto closed = ::close(descriptor);
    descriptor = -1;
    if (closed != 0)
      throw Failure("recovery", "Could not write the recovery kit");
    std::fill(pdf.begin(), pdf.end(), '\0');
  } catch (...) {
    std::fill(pdf.begin(), pdf.end(), '\0');
    if (descriptor >= 0)
      ::close(descriptor);
    std::error_code error;
    std::filesystem::remove_all(folder, error);
    throw;
  }
  // Copies must remain available for pasting, but expire on the next export
  // after 24 hours. Never follow links while purging old private directories.
  std::error_code error;
  for (std::filesystem::directory_iterator it(root, error), end;
       !error && it != end; it.increment(error)) {
    auto name = it->path().filename().string();
    if (it->path() == folder || name.size() != 10 ||
        name.substr(0, 4) != "kit-" || it->is_symlink(error) ||
        !it->is_directory(error))
      continue;
    auto modified = it->last_write_time(error);
    if (!error && std::filesystem::file_time_type::clock::now() - modified >
                      std::chrono::hours(24))
      std::filesystem::remove_all(it->path(), error);
  }
  return file;
}

void copyRecoveryKitFile(const std::filesystem::path &path) {
  if (!path.is_absolute() || !std::filesystem::is_regular_file(path))
    throw Failure("clipboard", "Recovery kit file is unavailable");
  ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
  writer.MarkAsConfidential();
  writer.WriteFilenames(ui::FileInfosToURIList(
      {ui::FileInfo(base::FilePath(path.string()), base::FilePath())}));
}
} // namespace bay::sync
