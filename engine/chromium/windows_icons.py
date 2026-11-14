#!/usr/bin/env python3
"""Package existing Bay app-icon PNGs into the Windows resource ICO."""
import argparse
import binascii
from pathlib import Path
import struct
import zlib

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parents[1] / "apps/browser/macos/Bay-macOS/Assets.xcassets/AppIcon.appiconset"
OUTPUT = HERE / "assets/windows/bay.ico"
IMAGES = ((16, "icon_16x16_1x.png"), (32, "icon_32x32_1x.png"),
          (64, "icon_32x32_2x.png"), (128, "icon_128x128_1x.png"),
          (256, "icon_256x256_1x.png"))
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunks(png):
    if not png.startswith(PNG_SIGNATURE):
        raise ValueError("App icon must be a PNG")
    cursor = len(PNG_SIGNATURE)
    result = []
    while cursor + 12 <= len(png):
        length = struct.unpack_from(">I", png, cursor)[0]
        end = cursor + length + 12
        if end > len(png):
            raise ValueError("Truncated app icon PNG")
        kind, data = png[cursor + 4:cursor + 8], png[cursor + 8:end - 4]
        checksum = struct.unpack_from(">I", png, end - 4)[0]
        if binascii.crc32(kind + data) != checksum:
            raise ValueError("App icon PNG checksum mismatch")
        result.append((kind, data))
        cursor = end
        if kind == b"IEND":
            break
    if cursor != len(png) or not result or result[-1] != (b"IEND", b""):
        raise ValueError("Invalid app icon PNG ending")
    return result


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data))


def rgba_png(png, size):
    parts = chunks(png)
    if parts[0][0] != b"IHDR":
        raise ValueError("App icon PNG has no header")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", parts[0][1])
    if (width, height, depth, compression, filtering, interlace) != (size, size, 8, 0, 0, 0):
        raise ValueError(f"Expected a noninterlaced 8-bit {size}px app icon")
    if color == 6:
        return png
    if color != 3:
        raise ValueError("App icons must use RGBA or indexed color")
    # Windows PNG-compressed icon entries require 32bpp ARGB. The existing
    # 16px asset is indexed: expand its palette without resampling any pixels.
    palette = next(data for kind, data in parts if kind == b"PLTE")
    alpha = next((data for kind, data in parts if kind == b"tRNS"), b"")
    if not palette or len(palette) % 3 or len(palette) > 768 or len(alpha) > len(palette) // 3:
        raise ValueError("Invalid app icon palette")
    raw = zlib.decompress(b"".join(data for kind, data in parts if kind == b"IDAT"))
    if len(raw) != (width + 1) * height:
        raise ValueError("Invalid indexed app icon scanlines")
    rgba = bytearray()
    previous = bytes(width)
    for row in range(height):
        start = row * (width + 1)
        rule = raw[start]
        pixels = bytearray(raw[start + 1:start + 1 + width])
        for x in range(width):
            left, up = pixels[x - 1] if x else 0, previous[x]
            upper_left = previous[x - 1] if x else 0
            if rule == 0:
                prediction = 0
            elif rule == 1:
                prediction = left
            elif rule == 2:
                prediction = up
            elif rule == 3:
                prediction = (left + up) // 2
            elif rule == 4:
                p = left + up - upper_left
                prediction = min((left, up, upper_left), key=lambda value: abs(p - value))
            else:
                raise ValueError("Invalid app icon PNG filter")
            pixels[x] = (pixels[x] + prediction) & 255
        rgba.append(0)
        for index in pixels:
            if index >= len(palette) // 3:
                raise ValueError("App icon palette index is out of range")
            rgba.extend(palette[index * 3:index * 3 + 3])
            rgba.append(alpha[index] if index < len(alpha) else 255)
        previous = pixels
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    metadata = {b"cHRM", b"gAMA", b"iCCP", b"sRGB", b"pHYs", b"tEXt", b"zTXt", b"iTXt", b"tIME"}
    return (PNG_SIGNATURE + chunk(b"IHDR", header) +
            b"".join(chunk(kind, data) for kind, data in parts if kind in metadata) +
            chunk(b"IDAT", zlib.compress(rgba, 9)) + chunk(b"IEND", b""))


def build_icon(assets=ASSETS):
    entries, payloads = bytearray(), bytearray()
    offset = 6 + 16 * len(IMAGES)
    for size, name in IMAGES:
        png = rgba_png((assets / name).read_bytes(), size)
        entries.extend(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset))
        payloads.extend(png)
        offset += len(png)
    return struct.pack("<HHH", 0, 1, len(IMAGES)) + entries + payloads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    icon = build_icon()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != icon:
            parser.exit(1, "Windows icon differs from the Bay app assets; run windows_icons.py\n")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(icon)


if __name__ == "__main__":
    main()
