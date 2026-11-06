const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// @bay/core is linked from the repo's packages/, outside this project.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../../packages/core")];

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
});
