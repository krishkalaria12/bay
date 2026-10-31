#pragma once
#include "SyncCrypto.h"
namespace bay::sync {
std::string recoveryPhrase(const Bytes &entropy);
std::string recoveryKitText(const Bytes &entropy, const std::string &device);
std::string recoveryKitPDF(const Bytes &entropy, const std::string &device);
Bytes recoveryQrPNG(const Bytes &entropy);
Bytes recoveryKitPreviewPNG(const Bytes &entropy, const std::string &device,
                            unsigned width);
#if defined(_WIN32) || defined(__linux__) || defined(BAY_SYNC_LINUX_TEST)
std::filesystem::path
temporaryRecoveryKit(const Bytes &entropy, const std::string &device,
                     const std::filesystem::path &dataDirectory);
void copyRecoveryKitFile(const std::filesystem::path &path);
#endif
} // namespace bay::sync
