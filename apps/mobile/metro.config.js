const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// @bay/core and @bay/sync are linked from the repo's packages/, outside this project, and their own dependencies
// (valibot, lz-string, the noble crypto) live in the repo's node_modules: Metro only serves files it watches, so that
// folder has to be watched too, or the packages that import them cannot be bundled. The app imports @bay/sync's plain
// TypeScript modules only (src/sync), never its index, whose native module is the desktop's.
const repo = path.resolve(__dirname, "../..");

config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(repo, "packages/core"),
  path.resolve(repo, "packages/sync"),
  path.resolve(repo, "node_modules"),
];

config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(repo, "node_modules")];

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
});
