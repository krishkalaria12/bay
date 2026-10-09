import { transformSync } from "@babel/core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Every component and hook is memoized by the React Compiler (babel.config.js), so none memoizes by hand. One the
// compiler can't lower is left as it is, silently: this fails on it, so a bail-out shows up here instead of as a
// slow component. A function that opts out with "use no memo" is skipped.
const require = createRequire(import.meta.url);
const compiler = require.resolve("babel-plugin-react-compiler");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps/browser/src/**/*.ts", "apps/browser/src/**/*.tsx", "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"], { cwd: repo, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.endsWith(".d.ts"));

const optedOut = (src, loc) => !!loc && src.slice(loc.start.index, loc.end.index).includes('"use no memo"');
const reasonOf = (detail) => detail?.reason ?? detail?.options?.reason ?? String(detail);
const lineOf = (event) => event.detail?.loc?.start?.line ?? event.detail?.options?.loc?.start?.line ?? event.fnLoc?.start?.line;

let compiled = 0;
const failures = [];
for (const file of files) {
  const src = readFileSync(repo + file, "utf8");
  transformSync(src, {
    filename: file,
    babelrc: false,
    configFile: false,
    code: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        compiler,
        {
          target: "19",
          panicThreshold: "none",
          logger: {
            logEvent(_, event) {
              if (event.kind === "CompileSuccess") compiled++;
              else if ((event.kind === "CompileError" || event.kind === "PipelineError") && !optedOut(src, event.fnLoc)) {
                failures.push(`${file}:${lineOf(event)} ${reasonOf(event.detail)}`);
              }
            },
          },
        },
      ],
    ],
  });
}

if (failures.length) {
  console.error(`The React Compiler couldn't compile ${failures.length} function(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`✓ ${compiled} components and hooks compiled in ${files.length} files`);
