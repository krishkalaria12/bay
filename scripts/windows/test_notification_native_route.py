"""Linux native-only notification routing must reject a retained fallback."""
import importlib.util
from pathlib import Path
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_route_series", REPO / "engine/patches/series.py")
series = importlib.util.module_from_spec(spec)
spec.loader.exec_module(series)


class NotificationNativeRouteTests(unittest.TestCase):
    def test_selected_route_query_is_linux_only(self):
        name = "chromium-bay-notification-native-route-linux.patch"
        for platform in ("win", "mac", "linux"):
            self.assertEqual(name in {step.name for step in series.read_series(platform)}, platform == "linux")
        patch = (REPO / "engine/patches" / name).read_text()
        self.assertIn("bridge_delegator_initialized_ && bridge_delegator_->HasSystemBridge()", patch)
        self.assertIn("BayNativeRouteDoesNotFollowPreferenceAfterConstruction", patch)
        source = (REPO / "engine/chromium/src/chrome/browser/bay/webui/notifications.cc").read_text()
        self.assertIn("!service->UsesSystemNotificationBridge()", source)


if __name__ == "__main__":
    unittest.main()
