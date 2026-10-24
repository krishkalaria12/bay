#include "RecoveryKit.h"
#include "RecoveryKitInternal.h"
#include "vendor/qrcodegen.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <limits>
#include <mutex>
#include <sstream>
#include <thread>

namespace bay::sync {
namespace {
using QR = qrcodegen::QrCode;
QR qrCode(const Bytes &entropy) {
  return QR::encodeText(recoveryPhrase(entropy).c_str(), QR::Ecc::MEDIUM);
}
void append32(Bytes &output, std::uint32_t value) {
  for (int i = 24; i >= 0; i -= 8)
    output.push_back(static_cast<std::uint8_t>(value >> i));
}
std::uint32_t crc32(const std::uint8_t *data, std::size_t size) {
  std::uint32_t crc = ~0u;
  for (std::size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xedb88320u & -(crc & 1));
  }
  return ~crc;
}
void chunk(Bytes &png, const std::array<char, 4> &type, const Bytes &data) {
  append32(png, static_cast<std::uint32_t>(data.size()));
  auto start = png.size();
  png.insert(png.end(), type.begin(), type.end());
  png.insert(png.end(), data.begin(), data.end());
  append32(png, crc32(png.data() + start, png.size() - start));
}
// A small PNG writer avoids an image-library dependency. Stored DEFLATE blocks
// are deliberate: these private, short-lived previews never leave the
// application.
Bytes pngRGB(unsigned width, unsigned height, const Bytes &rgb) {
  if (!width || !height || width > 4096 || height > 4096 ||
      rgb.size() != static_cast<std::size_t>(width) * height * 3)
    throw Failure("image", "Invalid recovery preview dimensions");
  Bytes filtered;
  filtered.reserve((static_cast<std::size_t>(width) * 3 + 1) * height);
  for (unsigned y = 0; y < height; ++y) {
    filtered.push_back(0);
    auto row = rgb.begin() + static_cast<std::size_t>(y) * width * 3;
    filtered.insert(filtered.end(), row, row + width * 3);
  }
  Bytes compressed{0x78, 0x01};
  for (std::size_t offset = 0; offset < filtered.size();) {
    auto count = static_cast<std::uint16_t>(
        std::min<std::size_t>(65535, filtered.size() - offset));
    compressed.push_back(offset + count == filtered.size() ? 1 : 0);
    compressed.push_back(count & 255);
    compressed.push_back(count >> 8);
    auto inverse = static_cast<std::uint16_t>(~count);
    compressed.push_back(inverse & 255);
    compressed.push_back(inverse >> 8);
    compressed.insert(compressed.end(), filtered.begin() + offset,
                      filtered.begin() + offset + count);
    offset += count;
  }
  std::uint32_t a = 1, b = 0;
  for (auto byte : filtered) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  append32(compressed, (b << 16) | a);
  erase(filtered);
  Bytes result{137, 80, 78, 71, 13, 10, 26, 10}, header;
  append32(header, width);
  append32(header, height);
  header.insert(header.end(), {8, 2, 0, 0, 0});
  chunk(result, {'I', 'H', 'D', 'R'}, header);
  chunk(result, {'I', 'D', 'A', 'T'}, compressed);
  chunk(result, {'I', 'E', 'N', 'D'}, {});
  erase(compressed);
  return result;
}
void drawQR(Bytes &rgb, unsigned width, unsigned height, const QR &qr,
            unsigned left, unsigned top, unsigned scale) {
  const unsigned size = static_cast<unsigned>(qr.getSize());
  for (unsigned y = 0; y < size; ++y)
    for (unsigned x = 0; x < size; ++x)
      if (qr.getModule(static_cast<int>(x), static_cast<int>(y)))
        for (unsigned dy = 0; dy < scale; ++dy)
          for (unsigned dx = 0; dx < scale; ++dx) {
            auto px = left + x * scale + dx, py = top + y * scale + dy;
            if (px < width && py < height) {
              auto index = (static_cast<std::size_t>(py) * width + px) * 3;
              rgb[index] = rgb[index + 1] = rgb[index + 2] = 0;
            }
          }
}
std::string escaped(const std::string &value) {
  std::string out;
  for (unsigned char c : value) {
    if (c == '(' || c == ')' || c == '\\')
      out += '\\';
    out += c >= 32 && c < 127 ? static_cast<char>(c) : '?';
  }
  return out;
}
std::string pdfText(double x, double y, unsigned size,
                    const std::string &value) {
  std::ostringstream out;
  out << "BT /F1 " << size << " Tf " << x << ' ' << y << " Td ("
      << escaped(value) << ") Tj ET\n";
  return out.str();
}
} // namespace
namespace detail {
Bytes encodeRGBPNG(unsigned width, unsigned height, const Bytes &rgb) {
  return pngRGB(width, height, rgb);
}
void drawRecoveryQR(Bytes &rgb, unsigned width, unsigned height,
                    const Bytes &entropy, unsigned left, unsigned top,
                    unsigned scale) {
  drawQR(rgb, width, height, qrCode(entropy), left, top, scale);
}
unsigned recoveryQRSize(const Bytes &entropy) {
  return static_cast<unsigned>(qrCode(entropy).getSize());
}
} // namespace detail
#if (!defined(_WIN32) && !defined(__linux__)) || defined(BAY_SYNC_PORTABLE_TEST)
Bytes recoveryKitPreviewPNG(const Bytes &, const std::string &, unsigned) {
  throw Failure("unsupported", "Recovery preview rendering requires Windows");
}
#endif
std::string recoveryPhrase(const Bytes &entropy) {
  auto words = recoveryWords(entropy);
  std::string out;
  for (auto &word : words) {
    if (!out.empty())
      out += ' ';
    out += word;
  }
  return out;
}
std::string recoveryKitText(const Bytes &entropy, const std::string &device) {
  std::string out =
      "Bay Recovery Kit\r\nCreated on " + device +
      "\r\n\r\nTo recover your data on another computer:\r\n1. Open "
      "Bay > Settings > Sync and choose the same sync folder.\r\n2. Click "
      "Enter Recovery Phrase.\r\n3. Enter these 24 words in order.\r\n\r\n";
  auto words = recoveryWords(entropy);
  for (std::size_t i = 0; i < words.size(); ++i)
    out += std::to_string(i + 1) + ". " + words[i] + "\r\n";
  return out +
         "\r\nKeep this kit private, in a password manager or a safe printed "
         "copy.\r\nAnyone with these words and your sync folder can read your "
         "data.\r\nBay cannot recover these words for you.\r\n";
}
std::string recoveryKitPDF(const Bytes &entropy, const std::string &device) {
  std::string content =
      pdfText(50, 744, 24, "Bay Recovery Kit") +
      pdfText(50, 720, 11, "Created on " + device) +
      pdfText(50, 680, 12, "To recover your data on another computer:");
  content +=
      pdfText(
          50, 656, 11,
          "1. Open Bay > Settings > Sync and choose the same sync folder.") +
      pdfText(50, 636, 11, "2. Click Enter Recovery Phrase.") +
      pdfText(50, 616, 11, "3. Enter these 24 words in order.");
  auto words = recoveryWords(entropy);
  content += "0.96 g 45 384 522 198 re f 0 g\n";
  for (std::size_t i = 0; i < words.size(); ++i)
    content += pdfText(60 + (i / 6) * 127, 550 - (i % 6) * 28, 12,
                       std::to_string(i + 1) + ". " + words[i]);
  auto qr = qrCode(entropy);
  double scale = 132.0 / (qr.getSize() + 8), left = 50 + 4 * scale,
         bottom = 204 + 4 * scale;
  std::ostringstream drawing;
  drawing << std::fixed << std::setprecision(4);
  for (int y = 0; y < qr.getSize(); ++y)
    for (int x = 0; x < qr.getSize(); ++x)
      if (qr.getModule(x, y))
        drawing << left + x * scale << ' '
                << bottom + (qr.getSize() - 1 - y) * scale << ' ' << scale
                << ' ' << scale << " re f\n";
  content += drawing.str();
  content +=
      pdfText(208, 306, 11, "The QR code contains your recovery phrase.") +
      pdfText(208, 286, 11, "Scan it only on a device you trust.") +
      pdfText(50, 158, 11,
              "Keep this kit in a password manager or a safe printed copy.") +
      pdfText(
          50, 138, 11,
          "Anyone with these words and your sync folder can read your data.") +
      pdfText(50, 118, 11, "Bay cannot recover these words for you.");
  std::vector<std::string> objects = {
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << "
      "/Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Length " + std::to_string(content.size()) + " >>\nstream\n" +
          content + "\nendstream"};
  std::string pdf = "%PDF-1.4\n";
  std::vector<std::size_t> offsets{0};
  for (std::size_t i = 0; i < objects.size(); ++i) {
    offsets.push_back(pdf.size());
    pdf += std::to_string(i + 1) + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  auto xref = pdf.size();
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (std::size_t i = 1; i < offsets.size(); ++i) {
    std::ostringstream line;
    line << std::setfill('0') << std::setw(10) << offsets[i];
    pdf += line.str() + " 00000 n \n";
  }
  return pdf + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
         std::to_string(xref) + "\n%%EOF\n";
}
Bytes recoveryQrPNG(const Bytes &entropy) {
  auto qr = qrCode(entropy);
  constexpr unsigned scale = 8, border = 4;
  unsigned width = (static_cast<unsigned>(qr.getSize()) + border * 2) * scale;
  Bytes pixels(static_cast<std::size_t>(width) * width * 3, 255);
  drawQR(pixels, width, width, qr, border * scale, border * scale, scale);
  auto png = pngRGB(width, width, pixels);
  erase(pixels);
  return png;
}

} // namespace bay::sync
