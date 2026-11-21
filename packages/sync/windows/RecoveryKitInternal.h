#pragma once
#include "SyncCrypto.h"
namespace bay::sync::detail {
Bytes encodeRGBPNG(unsigned width, unsigned height, const Bytes &rgb);
void drawRecoveryQR(Bytes &rgb, unsigned width, unsigned height,
                    const Bytes &entropy, unsigned left, unsigned top,
                    unsigned scale);
unsigned recoveryQRSize(const Bytes &entropy);
} // namespace bay::sync::detail
