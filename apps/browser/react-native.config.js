const path = require("node:path");

module.exports = {
  reactNativePath: path.dirname(require.resolve(process.platform === "win32" ? "react-native/package.json" : "react-native-macos/package.json")),
  project: {
    macos: { sourceDir: "./macos" },
    windows: { sourceDir: "./windows", solutionFile: "Bay.sln", project: { projectFile: "Bay/Bay.vcxproj" } },
  },
};
