const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = mergeConfig(getDefaultConfig(projectRoot), {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [path.resolve(workspaceRoot, "node_modules")],
    resolveRequest(context, moduleName, platform) {
      if (platform === "macos" && (moduleName === "react-native" || moduleName.startsWith("react-native/"))) {
        moduleName = moduleName.replace(/^react-native/, "react-native-macos");
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

// Modules load as the bundle starts, not at their first use. With inline requires every use of an import is a module
// lookup: 2.5–3.4% of the JS thread while tabs switch, open and close. The app needs most of its modules for its first
// window anyway: measured on the Release bench (3 alternating launches), evaluating the bundle took 8 ms longer and the
// first window came 27 ms sooner; opening a tab took 14% less, closing one 16% less, and the bytecode is 250 KB smaller.
config.transformer.getTransformOptions = async () => ({ transform: { experimentalImportSupport: false, inlineRequires: false } });

module.exports = config;
