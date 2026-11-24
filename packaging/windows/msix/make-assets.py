#!/usr/bin/env python3
"""Draw the MSIX package's logos (Assets/) from the Mac app's icon set. Needs Pillow; run it after the icon changes:

    python3 -m pip install pillow && python3 packaging/windows/msix/make-assets.py

Every logo comes at each scale Windows asks for, and the taskbar's at each target size, so package.ps1's resources.pri
can pick a sharp one. The icon brings its own plate, so tiles centre it on a transparent background (BackgroundColor
in the manifest is transparent) and the small sizes use the icon set's small cut, as bay.ico does.
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ICONS = HERE.parents[2] / 'apps/browser/macos/Bay-macOS/Assets.xcassets/AppIcon.appiconset'
OUTPUT = HERE / 'Assets'
SCALES = (100, 125, 150, 200, 400)
# Logo name, its size at 100%, and how much of the shorter side the icon fills.
LOGOS = (
    ('Square44x44Logo', (44, 44), 1.0),
    ('StoreLogo', (50, 50), 1.0),
    ('Square71x71Logo', (71, 71), 0.66),
    ('Square150x150Logo', (150, 150), 0.66),
    ('Wide310x150Logo', (310, 150), 0.66),
    ('Square310x310Logo', (310, 310), 0.66),
)
TARGET_SIZES = (16, 24, 32, 48, 256)


def source(size):
    """The icon at a size: the small cut up to 32 px, the full mark above."""
    if size <= 16:
        name = 'icon_16x16_1x.png'
    elif size <= 32:
        name = 'icon_16x16_2x.png'
    elif size <= 64:
        name = 'icon_32x32_2x.png'
    else:
        name = 'icon_512x512_2x.png'
    return Image.open(ICONS / name).convert('RGBA').resize((size, size), Image.Resampling.LANCZOS)


def logo(width, height, fill):
    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    side = round(min(width, height) * fill)
    canvas.alpha_composite(source(side), ((width - side) // 2, (height - side) // 2))
    return canvas


def main():
    OUTPUT.mkdir(exist_ok=True)
    for stale in OUTPUT.glob('*.png'):
        stale.unlink()
    for name, (width, height), fill in LOGOS:
        for scale in SCALES:
            image = logo(round(width * scale / 100), round(height * scale / 100), fill)
            image.save(OUTPUT / f'{name}.scale-{scale}.png', optimize=True)
    # The taskbar, Start's list and Explorer ask for exact sizes; unplated is what they show on Windows 10 and 11.
    for size in TARGET_SIZES:
        image = logo(size, size, 1.0)
        image.save(OUTPUT / f'Square44x44Logo.targetsize-{size}.png', optimize=True)
        image.save(OUTPUT / f'Square44x44Logo.targetsize-{size}_altform-unplated.png', optimize=True)


if __name__ == '__main__':
    main()
