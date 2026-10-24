`bay.ico` packages the existing macOS Bay app-icon assets at 16, 32, 64, 128 and
256 pixels. Regenerate it with `python3 engine/chromium/windows_icons.py` and
verify it with `--check`. No image is resized or redrawn. The indexed 16px PNG
is expanded losslessly to RGBA because Windows requires 32bpp PNG icon entries.

The Windows layer copies this ICO to Chromium's existing application, HTML and
PDF resource paths. Their resource IDs and ordering remain unchanged. The
macOS layer does not copy these files.

Format reference: [Microsoft's PNG icon documentation](https://devblogs.microsoft.com/oldnewthing/20101022-00/?p=12473).
