"""Keep engine/android/api-stub in step with the engine's real public Java API."""
from pathlib import Path
import re
import unittest

REPO = Path(__file__).resolve().parents[2]
STUB = REPO / "engine/android/api-stub/java/org/bay/engine"
REAL = REPO / "engine/android/src/bay/mobile/java/src/org/bay/engine"

# Statements inside bodies, not declarations.
SKIPPED = ("throw ", "return ", "super(", "package ", "import ", "private ")


def declarations(source):
    """The file's declarations (classes, fields, constructors, methods), one string each, whitespace collapsed."""
    source = re.sub(r"/\*.*?\*/|//[^\n]*", "", source, flags=re.S)
    source = re.sub(r'"(?:\\.|[^"\\])*"', '""', source)
    source = " ".join(source.split())
    parts = (part.strip() for part in re.split(r"[{};]", source))
    return [part for part in parts if part and not part.startswith(SKIPPED)]


class ApiStubTests(unittest.TestCase):
    def test_every_stub_declaration_is_real(self):
        stubs = sorted(STUB.glob("*.java"))
        self.assertTrue(stubs)
        for stub in stubs:
            real = REAL / stub.name
            self.assertTrue(real.is_file(), f"{stub.name} has no engine class")
            real_declarations = declarations(real.read_text())
            for declaration in declarations(stub.read_text()):
                with self.subTest(file=stub.name, declaration=declaration):
                    self.assertTrue(any(declaration in candidate for candidate in real_declarations))

    def test_the_client_interface_is_whole(self):
        # The app implements BayTabClient, so the stub must have every method, not only some.
        stub = set(declarations((STUB / "BayTabClient.java").read_text()))
        real = set(declarations((REAL / "BayTabClient.java").read_text()))
        self.assertEqual(stub, real)

    def test_declarations_ignore_comments_and_bodies(self):
        found = declarations('/** Doc. */ public final class A { // note\n public int b(String c) { return "{"; } }')
        self.assertEqual(found, ["public final class A", "public int b(String c)"])


if __name__ == "__main__":
    unittest.main()
