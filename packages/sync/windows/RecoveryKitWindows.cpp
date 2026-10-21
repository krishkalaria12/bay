#include "RecoveryKit.h"
#include "RecoveryKitInternal.h"
#ifdef _WIN32
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <fstream>

#include <sddl.h>
#include <shellapi.h>
#pragma comment(lib, "gdi32.lib")

namespace bay::sync {
namespace {

HWND activeWindow() {
  auto window = GetActiveWindow();
  if (!window) {
    window = GetForegroundWindow();
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    if (process != GetCurrentProcessId())
      window = nullptr;
  }
  if (!window)
    throw Failure("window", "Open a Bay window to share the recovery kit");
  return window;
}
struct Bitmap {
  HDC dc = nullptr;
  HBITMAP bitmap = nullptr;
  HGDIOBJ previous = nullptr;
  void *pixels = nullptr;
  std::size_t byteCount = 0;
  Bitmap(unsigned width, unsigned height) {
    byteCount = static_cast<std::size_t>(width) * height * 4;
    dc = CreateCompatibleDC(nullptr);
    if (!dc)
      throw Failure("image", "Could not create recovery preview");
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = static_cast<LONG>(width);
    info.bmiHeader.biHeight = -static_cast<LONG>(height);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (!bitmap) {
      DeleteDC(dc);
      throw Failure("image", "Could not create recovery preview bitmap");
    }
    previous = SelectObject(dc, bitmap);
    memset(pixels, 255, static_cast<std::size_t>(width) * height * 4);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(25, 25, 25));
  }
  ~Bitmap() {
    if (dc) {
      if (pixels)
        SecureZeroMemory(pixels, byteCount);
      SelectObject(dc, previous);
      DeleteObject(bitmap);
      DeleteDC(dc);
    }
  }
};
void drawText(HDC dc, const std::string &text, int x, int y, int size,
              int weight = FW_NORMAL) {
  auto n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                               static_cast<int>(text.size()), nullptr, 0);
  std::wstring wide(static_cast<std::size_t>(n), 0);
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      wide.data(), n);
  auto font =
      CreateFontW(size, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                  OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                  DEFAULT_PITCH, L"Segoe UI");
  auto old = SelectObject(dc, font);
  TextOutW(dc, x, y, wide.c_str(), n);
  SelectObject(dc, old);
  DeleteObject(font);
}

} // namespace
Bytes recoveryKitPreviewPNG(const Bytes &entropy, const std::string &device,
                            unsigned width) {
  width = std::clamp(width, 168u, 1224u);
  unsigned height = width * 792 / 612;
  Bitmap image(width, height);
  auto x = [&](int coordinate) {
    return MulDiv(coordinate, static_cast<int>(width), 612);
  };
  drawText(image.dc, "Bay Recovery Kit", x(50), x(48), x(24), FW_BOLD);
  drawText(image.dc, "Created on " + device, x(50), x(80), x(11));
  drawText(image.dc, "To recover on another Mac or Windows PC:", x(50), x(118),
           x(12));
  drawText(image.dc, "1. Open Bay > Settings > Sync. Choose the same folder.",
           x(50), x(145), x(11));
  drawText(image.dc, "2. Click Enter Recovery Phrase.", x(50), x(166), x(11));
  drawText(image.dc, "3. Enter these 24 words in order.", x(50), x(187), x(11));
  auto words = recoveryWords(entropy);
  for (std::size_t i = 0; i < words.size(); ++i)
    drawText(image.dc, std::to_string(i + 1) + ". " + words[i],
             x(50 + static_cast<int>(i / 6) * 127),
             x(240 + static_cast<int>(i % 6) * 28), x(12));
  drawText(image.dc, "Keep this kit private. Store it somewhere safe.", x(50),
           x(642), x(11));
  drawText(image.dc,
           "Anyone with these words and the folder can read your data.", x(50),
           x(662), x(11));
  drawText(image.dc, "Bay cannot recover these words for you.", x(50), x(682),
           x(11));
  GdiFlush();
  auto *bgra = static_cast<const std::uint8_t *>(image.pixels);
  Bytes pixels(static_cast<std::size_t>(width) * height * 3);
  for (std::size_t i = 0; i < static_cast<std::size_t>(width) * height; ++i) {
    pixels[i * 3] = bgra[i * 4 + 2];
    pixels[i * 3 + 1] = bgra[i * 4 + 1];
    pixels[i * 3 + 2] = bgra[i * 4];
  }
  auto qrScale = std::max(1u, static_cast<unsigned>(x(144)) /
                                  (detail::recoveryQRSize(entropy) + 8));
  detail::drawRecoveryQR(pixels, width, height, entropy,
                         static_cast<unsigned>(x(50)) + 4 * qrScale,
                         static_cast<unsigned>(x(430)) + 4 * qrScale, qrScale);
  auto png = detail::encodeRGBPNG(width, height, pixels);
  erase(pixels);
  SecureZeroMemory(image.pixels, static_cast<std::size_t>(width) * height * 4);
  return png;
}

std::filesystem::path
temporaryRecoveryKit(const Bytes &entropy, const std::string &device,
                     const std::filesystem::path &directory) {
  auto root = directory / L"Recovery Kits";
  std::filesystem::create_directories(root);
  auto path = root / std::filesystem::u8path(base32(randomBytes(16)));
  createPrivateDirectory(path);
  auto file = path / L"Bay Recovery Kit.pdf";
  auto pdf = recoveryKitPDF(entropy, device);
  std::ofstream stream(file, std::ios::binary | std::ios::trunc);
  stream.write(pdf.data(), pdf.size());
  SecureZeroMemory(pdf.data(), pdf.size());
  if (!stream) {
    std::error_code error;
    std::filesystem::remove_all(path, error);
    throw Failure("recovery", "Could not write the recovery kit");
  }
  // Purge expired copies on every export. Per-user ACLs protect copies across
  // restarts.
  std::error_code error;
  for (std::filesystem::directory_iterator it(root, error), end;
       !error && it != end; it.increment(error)) {
    if (it->path() == path || !isTag(it->path().filename().u8string()) ||
        it->is_symlink())
      continue;
    auto modified = it->last_write_time(error);
    if (!error && std::filesystem::file_time_type::clock::now() - modified >
                      std::chrono::hours(24))
      std::filesystem::remove_all(it->path(), error);
  }
  return file;
}
void copyRecoveryKitFile(const std::filesystem::path &path) {
  auto value = path.wstring();
  auto size = sizeof(DROPFILES) + (value.size() + 2) * sizeof(wchar_t);
  auto block = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size);
  if (!block)
    throw Failure("clipboard", "Could not copy the recovery kit");
  auto data = static_cast<DROPFILES *>(GlobalLock(block));
  if (!data) {
    GlobalFree(block);
    throw Failure("clipboard", "Clipboard memory is unavailable");
  }
  data->pFiles = sizeof(DROPFILES);
  data->fWide = TRUE;
  memcpy(reinterpret_cast<std::uint8_t *>(data) + sizeof(DROPFILES),
         value.c_str(), (value.size() + 1) * sizeof(wchar_t));
  GlobalUnlock(block);
  if (!OpenClipboard(activeWindow())) {
    GlobalFree(block);
    throw Failure("clipboard", "Clipboard is busy");
  }
  EmptyClipboard();
  DWORD disabled = 0;
  for (auto name :
       {L"CanIncludeInClipboardHistory", L"CanUploadToCloudClipboard"}) {
    auto option = GlobalAlloc(GMEM_MOVEABLE, sizeof(disabled));
    if (!option)
      continue;
    auto data = GlobalLock(option);
    if (!data) {
      GlobalFree(option);
      continue;
    }
    memcpy(data, &disabled, sizeof(disabled));
    GlobalUnlock(option);
    if (!SetClipboardData(RegisterClipboardFormatW(name), option))
      GlobalFree(option);
  }
  bool ok = SetClipboardData(CF_HDROP, block) != nullptr;
  CloseClipboard();
  if (!ok) {
    GlobalFree(block);
    throw Failure("clipboard", "Could not copy the recovery kit");
  }
}
} // namespace bay::sync
#endif
