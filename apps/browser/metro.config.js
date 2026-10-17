const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = mergeConfig(getDefaultConfig(projectRoot), {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [path.resolve(workspaceRoot, "node_modules")],
    blockList: [/[/\\]windows[/\\](?:x64|ARM64|Generated Files|packages|bundle)[/\\]/, /\.ProjectImports\.zip$/],
    resolveRequest(context, moduleName, platform) {
      if ((platform === "macos" || platform === "windows") && (moduleName === "react-native" || moduleName.startsWith("react-native/"))) {
        moduleName = moduleName.replace(/^react-native/, platform === "macos" ? "react-native-macos" : "react-native-windows");
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
