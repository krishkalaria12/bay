const path = require("node:path");
const { mergeConfig } = require("@react-native/metro-config");
const { getDefaultConfig } = process.env.BAY_WEB === "1" ? require("expo/metro-config") : require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = mergeConfig(getDefaultConfig(projectRoot), {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [path.resolve(workspaceRoot, "node_modules")],
    resolveRequest(context, moduleName, platform) {
      if (platform === "macos" && (moduleName === "react-native" || moduleName.startsWith("react-native/"))) {
        moduleName = moduleName.replace(/^react-native/, "react-native-macos");
      } else if (platform === "web" && moduleName === "react-native") {
        moduleName = "react-native-web";
      }
      // The render benchmark (scripts/perf/js-bench.mjs bundle --profiling) bundles React's profiling renderer:
      // production code that also times each component's render.
      if (process.env.NN_REACT_PROFILING === "1" && moduleName.endsWith("/ReactNativeRenderer-prod")) {
        moduleName = moduleName.replace(/-prod$/, "-profiling");
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
});

module.exports = config;
