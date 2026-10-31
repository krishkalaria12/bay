"""Compile the non-macOS CLI entry without POSIX or CEF headers."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
COMPILER = shutil.which("clang++") or shutil.which("c++")


@unittest.skipUnless(COMPILER, "requires a host C++ compiler")
class CliControlTests(unittest.TestCase):
    def test_non_mac_call_links_and_reports_unsupported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = root / "build/build_config.h"
            build.parent.mkdir(parents=True)
            build.write_text("#define BUILDFLAG(flag) flag\n#define IS_MAC 0\n")
            engine = root / "chrome/browser/bay/nn_engine.h"
            engine.parent.mkdir(parents=True)
            engine.write_text("""
#pragma once
#include <string_view>
using nn_engine_reply_t = void (*)(const char*, void*);
#define NN_ENGINE_CALL(name) extern "C" void name(const char* profile_dir, const char* args_json, nn_engine_reply_t reply, void* context)
namespace bay {
class Reply {
 public:
  Reply(nn_engine_reply_t reply, void* context) : reply_(reply), context_(context) {}
  void Error(std::string_view message) { reply_(message.data(), context_); }
 private:
  nn_engine_reply_t reply_;
  void* context_;
};
}
""")
            main = root / "main.cc"
            main.write_text("""
#include "chrome/browser/bay/nn_engine.h"
NN_ENGINE_CALL(nn_cli_control);
int main() {
  bool rejected = false;
  nn_cli_control("", "{\\\"on\\\":true}", [](const char* message, void* context) {
    *static_cast<bool*>(context) = std::string_view(message).find("only available on macOS") != std::string_view::npos;
  }, &rejected);
  return rejected ? 0 : 1;
}
""")
            binary = root / "test"
            source = REPO / "engine/chromium/src/chrome/browser/bay/nn_cli_control.cc"
            subprocess.run([COMPILER, "-std=c++17", "-Werror", f"-I{root}", str(source), str(main), "-o", str(binary)], check=True, capture_output=True)
            subprocess.run([str(binary)], check=True)
