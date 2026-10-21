#pragma once
#include "SyncCrypto.h"
namespace bay::sync {
std::string recoveryPhrase(const Bytes &entropy);
std::string recoveryKitText(const Bytes &entropy, const std::string &device);
std::string recoveryKitPDF(const Bytes &entropy, const std::string &device);
Bytes recoveryQrPNG(const Bytes &entropy);
Bytes recoveryKitPreviewPNG(const Bytes &entropy, const std::string &device,
                            unsigned width);
#ifdef _WIN32
std::filesystem::path
temporaryRecoveryKit(const Bytes &entropy, const std::string &device,
                     const std::filesystem::path &dataDirectory);
void copyRecoveryKitFile(const std::filesystem::path &path);
#endif
} // namespace bay::sync
