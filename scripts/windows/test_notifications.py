"""Windows toast registration must match Chromium's compiled Bay identity."""
import importlib.util
from pathlib import Path
import re
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("notification_patch_series", REPO / "engine/patches/series.py")
series = importlib.util.module_from_spec(spec)
spec.loader.exec_module(series)


class NotificationRegistrationTests(unittest.TestCase):
    def test_notification_handler_patch_is_windows_only(self):
        name = "chromium-bay-notifications-win.patch"
        self.assertIn(name, {step.name for step in series.read_series("win")})
        self.assertNotIn(name, {step.name for step in series.read_series("mac")})
        patch = (REPO / "engine/patches" / name).read_text()
        added = "\n".join(line[1:] for line in patch.splitlines()
                          if line.startswith("+") and not line.startswith("+++"))
        self.assertIn("BAY = 13", added)
        self.assertIn("MAX = BAY", added)
        self.assertIn("g_bay_handler_initializer(service.get())", added)
        self.assertNotIn('#include "chrome/browser/bay/', added)

    def test_installer_shortcut_and_com_server_match_compiled_toast_clsid(self):
        patch = (REPO / "engine/patches/chromium-bay-branding-win.patch").read_text()
        added = "\n".join(line[1:] for line in patch.splitlines()
                          if line.startswith("+") and not line.startswith("+++"))
        mode = re.search(r"\.toast_activator_clsid = (.*?Toast Activator CLSID)", added, re.S)[1]
        a, b, c, *tail = [int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]+)", mode)]
        guid = f"{a:08X}-{b:04X}-{c:04X}-{tail[0]:02X}{tail[1]:02X}-" + "".join(f"{n:02X}" for n in tail[2:])
        installer = (REPO / "packaging/windows/Bay.iss").read_text()
        shortcuts = [line for line in installer.splitlines() if line.startswith("Name:") and "Filename:" in line]
        self.assertEqual(len(shortcuts), 2)
        for shortcut in shortcuts:
            self.assertIn('AppUserModelID: "Bay.Browser"', shortcut)
            self.assertIn(f'AppUserModelToastActivatorCLSID: "{guid}"', shortcut)
        # Registry strings expand constants, so the literal GUID opening brace
        # must be escaped. The shortcut parameter takes an unbraced GUID.
        prefix = "Software\\Classes\\CLSID\\{{" + guid + "}"
        rows = [line for line in installer.splitlines() if f'Subkey: "{prefix}' in line]
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(line.startswith("Root: HKCU;") for line in rows))
        self.assertIn('Flags: uninsdeletekey', rows[0])
        self.assertIn(r'ValueData: """{app}\notification_helper.exe"""', rows[1])
        self.assertIn('ValueName: "ServerExecutable"', rows[2])
        self.assertIn(r'ValueData: "{app}\notification_helper.exe"', rows[2])


if __name__ == "__main__":
    unittest.main()
