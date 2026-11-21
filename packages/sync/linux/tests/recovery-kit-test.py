#!/usr/bin/env python3
"""Exercise the actual POSIX export code without a Chromium/desktop build."""
import pathlib
import re
import subprocess
import tempfile

source = (pathlib.Path(__file__).parents[1] / "RecoveryKitLinux.cpp").read_text()
helper = source[source.index("void privateDirectory("):source.index("} // namespace")]
export = source[re.search(r"std::filesystem::path\s+temporaryRecoveryKit\(", source).start():source.index("void copyRecoveryKitFile(")]
harness = r'''
#include <algorithm>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <vector>
#include <sys/stat.h>
#include <unistd.h>
using Bytes = std::vector<unsigned char>;
struct Failure : std::runtime_error {
  Failure(const char *, const char *message) : std::runtime_error(message) {}
};
bool failPDF = false;
std::string recoveryKitPDF(const Bytes &, const std::string &) {
  if (failPDF) throw Failure("test", "failed rendering");
  return "%PDF-1.4 secret test phrase";
}
'''
harness += helper + export + r'''
int main(int argc, char **argv) {
  assert(argc == 2);
  std::filesystem::path root(argv[1]);
  auto file = temporaryRecoveryKit({}, "device", root);
  struct stat status {};
  assert(stat(file.c_str(), &status) == 0 && (status.st_mode & 0777) == 0600);
  assert(stat(file.parent_path().c_str(), &status) == 0 && (status.st_mode & 0777) == 0700);
  assert(stat(file.parent_path().parent_path().c_str(), &status) == 0 && (status.st_mode & 0777) == 0700);
  std::ifstream stream(file);
  std::string content((std::istreambuf_iterator<char>(stream)), {});
  assert(content == "%PDF-1.4 secret test phrase");
  auto kits = root / "Recovery Kits";
  auto old = kits / "kit-ABC123";
  std::filesystem::create_directory(old);
  std::ofstream(old / "secret") << "private";
  std::filesystem::last_write_time(old, std::filesystem::file_time_type::clock::now() - std::chrono::hours(25));
  auto outside = root / "outside";
  std::filesystem::create_directory(outside);
  std::ofstream(outside / "keep") << "keep";
  std::filesystem::create_directory_symlink(outside, kits / "kit-LINK12");
  temporaryRecoveryKit({}, "device", root);
  assert(!std::filesystem::exists(old));
  assert(std::filesystem::exists(outside / "keep"));
  auto count = std::distance(std::filesystem::directory_iterator(kits), std::filesystem::directory_iterator());
  failPDF = true;
  try { temporaryRecoveryKit({}, "device", root); assert(false); } catch (const Failure &) {}
  assert(count == std::distance(std::filesystem::directory_iterator(kits), std::filesystem::directory_iterator()));
  auto hostile = root / "hostile";
  std::filesystem::create_directory(hostile);
  std::filesystem::create_directory_symlink(outside, hostile / "Recovery Kits");
  try { temporaryRecoveryKit({}, "device", hostile); assert(false); } catch (const Failure &) {}
}
'''
with tempfile.TemporaryDirectory() as directory:
    directory = pathlib.Path(directory)
    (directory / "test.cpp").write_text(harness)
    subprocess.run(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", str(directory / "test.cpp"), "-o", str(directory / "test")], check=True)
    data = directory / "data"
    data.mkdir()
    subprocess.run([str(directory / "test"), str(data)], check=True)
print("Recovery kit POSIX privacy, export, cleanup, and symlink checks passed")
