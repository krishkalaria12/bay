#pragma once
#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace bay::importer::discovery {
struct Browser {
  std::string id, name;
  std::filesystem::path root;
  bool firefox = false, rootProfile = false;
  // Trusted product identity, independent of native/snap/Flatpak installation
  // ID. The secret backend maps this to its allowlisted browser enum.
  std::string productId{};
};
struct Environment {
  std::filesystem::path home, configHome;
};
// Explicit inputs keep portable fixture tests away from the real user's data.
Environment linuxEnvironment();
std::vector<Browser> linuxBrowsers(const Environment &environment);
// A browser's profiles in its data folder, and what one profile has to import:
// bay-import's discovery, shared with macOS. `rootId` names a data folder
// that is itself a profile (Opera); `arcSidebar` adds Arc's spaces.
nlohmann::json profiles(const Browser &browser, const std::string &rootId,
                        const std::filesystem::path &arcSidebar);
nlohmann::json available(const std::filesystem::path &profile, bool firefox);
nlohmann::json linuxAvailable(const std::filesystem::path &profile,
                              bool firefox);
nlohmann::json linuxProfiles(const Browser &browser);
} // namespace bay::importer::discovery
