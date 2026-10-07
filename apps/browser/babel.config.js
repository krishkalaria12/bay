// The React Compiler's output calls the global Symbol (`Symbol.for("react.memo_cache_sentinel")`), but most of our
// files import @bay/shell's `Symbol` icon, which shadows it there: `Symbol.for` was undefined and the app crashed on
// its first render. This points those calls back at the global.
function compilerGlobalSymbol({ types: t }) {
  return {
    visitor: {
      MemberExpression(path) {
        const { object, property } = path.node;
        if (!t.isIdentifier(object, { name: "Symbol" }) || !t.isIdentifier(property, { name: "for" })) return;
        const call = path.parentPath;
        const key = call.isCallExpression() && call.node.arguments[0];
        if (!t.isStringLiteral(key) || !key.value.startsWith("react.") || !path.scope.hasBinding("Symbol")) return;
        path.get("object").replaceWith(t.memberExpression(t.identifier("globalThis"), t.identifier("Symbol")));
      },
    },
  };
}

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    overrides: [
      {
        // The React Compiler memoizes our components and hooks (the app's and the workspace packages'), not
        // node_modules. babel-preset-expo only adds it under Expo's CLI; Metro here runs from the React Native CLI.
        test: (file) => !!file && !file.includes("/node_modules/"),
        plugins: [["babel-plugin-react-compiler", { target: "19" }], compilerGlobalSymbol],
      },
    ],
  };
};
