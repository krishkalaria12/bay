# QR encoder

`qrcodegen.cpp` and `qrcodegen.hpp` are unmodified files from
[Project Nayuki's QR Code generator, version 1.8.0](https://github.com/nayuki/QR-Code-generator/tree/v1.8.0/cpp).
Both files contain the complete MIT license and copyright notice.

Bay uses the encoder for recovery phrase QR codes and the vector QR in exported
PDF recovery kits. Encoding runs locally. The encoder has no network or image
library dependency.

The portable `RecoveryKit.cpp` includes the implementation directly, so build
systems should compile `RecoveryKit.cpp` and should not compile the vendor source
separately.
