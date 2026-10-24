#include "../windows/SyncCrypto.h"
#include "../windows/SyncService.h"
#include "base/strings/utf_string_conversions.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include <cerrno>
#include <fcntl.h>
#include <gio/gio.h>
#include <sys/stat.h>
#include <unistd.h>

namespace bay::sync {
void copyRecoveryPhraseText(const std::string &text) {
  ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
  writer.MarkAsConfidential();
  writer.WriteText(base::UTF8ToUTF16(text));
}
void revealSyncFolder(const std::filesystem::path &path) {
  GError *error = nullptr;
  auto *uri = g_filename_to_uri(path.c_str(), nullptr, &error);
  bool opened = uri && g_app_info_launch_default_for_uri(uri, nullptr, &error);
  g_free(uri);
  if (error)
    g_error_free(error);
  if (!opened)
    throw Failure("folder", "Could not open this sync folder");
}
void writeRecoveryKitFile(const std::filesystem::path &path,
                          const std::string &content) {
  int file =
      ::open(path.c_str(),
             O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (file < 0)
    throw Failure("save", "Could not save the recovery kit");
  bool ok = ::fchmod(file, 0600) == 0;
  std::size_t offset = 0;
  while (ok && offset < content.size()) {
    auto written =
        ::write(file, content.data() + offset, content.size() - offset);
    if (written < 0 && errno == EINTR)
      continue;
    if (written <= 0) {
      ok = false;
      break;
    }
    offset += written;
  }
  if (::close(file) != 0 || !ok)
    throw Failure("save", "Could not save the recovery kit");
}
} // namespace bay::sync
