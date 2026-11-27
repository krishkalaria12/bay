"""Tests for scripts/web-features.py: reading Chromium's headers, and what makes the map disagree with them."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("web_features", HERE / "web-features.py")
web_features = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web_features)

DELEGATE = """
// virtual void Commented(int);
class CONTENT_EXPORT WebContentsDelegate {
 public:
  virtual WebContents* OpenURLFromTab(WebContents* source,
                                      const OpenURLParams& params);
  virtual void RunFileChooser(RenderFrameHost* render_frame_host) {}
  /* virtual void AlsoCommented(); */
  virtual bool IsFullscreenForTabOrPending(const WebContents* web_contents);
  virtual void RunFileChooser(RenderFrameHost* render_frame_host, int mode) {}
 protected:
  virtual ~WebContentsDelegate();
};
"""

PERMISSIONS = """
enum class PermissionType {
  MIDI_SYSEX = 1,
  // PUSH_MESSAGING = 2,  // removed
  NOTIFICATIONS = 3,
  GEOLOCATION = 4,
  NUM,
  MIN_VALUE = MIDI_SYSEX,
  MAX_VALUE = NUM - 1,
};
"""


class Reading(unittest.TestCase):
    def test_delegate_methods_once_each_without_comments_or_destructor(self):
        self.assertEqual(web_features.delegate_methods(DELEGATE), ["OpenURLFromTab", "RunFileChooser", "IsFullscreenForTabOrPending"])

    def test_permission_types_without_bounds(self):
        self.assertEqual(web_features.permission_types(PERMISSIONS), ["MIDI_SYSEX", "NOTIFICATIONS", "GEOLOCATION"])

    def test_acceptance_checks(self):
        self.assertEqual(web_features.acceptance_checks('await check("window-open", async () => {});\ncheck("a-b2", f)'), {"window-open", "a-b2"})


class Problems(unittest.TestCase):
    table = {
        "delegate": {"OpenURLFromTab": "check:target-blank", "Gone": "default: Chrome's"},
        "permissions": {"MIDI_SYSEX": "checklist: SysEx asks", "NOTIFICATIONS": "check:missing"},
        "extras": {"sharing:web-share": "maybe", "x": "n/a:"},
    }

    def test_every_disagreement_is_named(self):
        found = web_features.problems(self.table, ["OpenURLFromTab", "SaveFrame"], ["MIDI_SYSEX", "NOTIFICATIONS"], {"target-blank"})
        self.assertEqual(
            sorted(line.split(":")[0] for line in found),
            sorted(["delegate.SaveFrame", "delegate.Gone", "permissions.NOTIFICATIONS", "extras.sharing", "extras.x"]),
        )

    def test_a_matching_map_has_none(self):
        table = {"delegate": {"OpenURLFromTab": "check:target-blank"}, "permissions": {"MIDI_SYSEX": "n/a: none"}}
        self.assertEqual(web_features.problems(table, ["OpenURLFromTab"], ["MIDI_SYSEX"], {"target-blank"}), [])

    def test_checklist_lines_once_with_their_rows(self):
        table = {"delegate": {"A": "checklist: one", "B": "checklist: one"}, "extras": {"c": "checklist: two", "d": "check:x"}}
        self.assertEqual(web_features.checklist(table), [("one", ["A", "B"]), ("two", ["c"])])


class TheShippedMap(unittest.TestCase):
    def test_every_row_says_what_covers_it_and_names_real_checks(self):
        table = json.loads(web_features.MAP.read_text(encoding="utf-8"))
        checks = web_features.acceptance_checks(web_features.ACCEPTANCE.read_text(encoding="utf-8"))
        names = lambda section: list(table[section])
        self.assertEqual(web_features.problems(table, names("delegate"), names("permissions"), checks), [])

    def test_check_reads_a_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            src = pathlib.Path(directory)
            for path, text in ((web_features.DELEGATE_HEADER, DELEGATE), (web_features.PERMISSION_HEADER, PERMISSIONS)):
                (src / path).parent.mkdir(parents=True, exist_ok=True)
                (src / path).write_text(text, encoding="utf-8")
            # The shipped map has far more rows than this fixture: the check fails.
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(web_features.check(src), 1)
            self.assertIn("no longer has it", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
