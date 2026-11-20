"""Check how series.py routes each step to the platforms that take it."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("series.py")
SPEC = importlib.util.spec_from_file_location("bay_series", SCRIPT)
series = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(series)


def listed_steps():
    """Every step line of the real series file, as `kind name`, in order."""
    steps = []
    for raw in (SCRIPT.parent / "series").read_text().splitlines():
        fields = raw.split("#", 1)[0].split()
        if fields:
            steps.append(f"{fields[0]} {fields[2]}")
    return steps


class SeriesRoutingTests(unittest.TestCase):
    def test_mac_takes_every_step_in_order(self):
        # Before platform routing, macOS applied every line; it still must.
        self.assertEqual([repr(step) for step in series.read_series("mac")], listed_steps())
        self.assertEqual([repr(step) for step in series.read_series()], listed_steps())

    def test_android_takes_no_desktop_step(self):
        steps = series.read_series("android")
        self.assertFalse([step for step in steps if step.kind == "cef"])
        names = {step.name for step in steps}
        self.assertNotIn("chromium-bay-layer.patch", names)
        self.assertNotIn("engine/nncore", names)
        self.assertNotIn("engine/chromium", names)

    def test_all_means_every_desktop_platform(self):
        for platform in ("mac", "win", "linux"):
            self.assertTrue(series.selects("all", platform))
        self.assertFalse(series.selects("all", "android"))
        self.assertTrue(series.selects("mac,android", "android"))
        self.assertFalse(series.selects("win,linux", "mac"))

    def test_malformed_lines_are_refused(self):
        for line in ("chromium a.patch", "chromium ios a.patch", "chromium mac,mac a.patch", "patch mac a.patch"):
            with tempfile.TemporaryDirectory() as directory, mock.patch.object(series, "HERE", directory):
                Path(directory, "a.patch").write_text("")
                Path(directory, "series").write_text(line + "\n")
                with self.assertRaises(SystemExit, msg=line):
                    series.read_series()

    def test_unknown_target_is_refused(self):
        with self.assertRaises(SystemExit):
            series.read_series("ios")


if __name__ == "__main__":
    unittest.main()
