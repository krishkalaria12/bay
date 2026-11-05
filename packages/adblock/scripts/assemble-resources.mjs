#!/usr/bin/env node
// Assembles the scriptlets and redirect resources Bay's blocker injects, in adblock-rust's `Resource` JSON format:
//   - uBlock Origin's scriptlets (`##+js(...)`) and their helper functions, from its `src/js/resources` modules;
//   - uBlock Origin's redirect resources (`$redirect=noop.js`…), from `src/web_accessible_resources`;
//   - Brave's own resources (brave/adblock-resources).
// adblock-rust 0.13 only reads uBO's old scriptlet format, so this loads uBO's current modules in Node and reads the
// scriptlets they register. Output: ../resources/resources.json (checked in; GPLv3 uBO and MPL-2.0 Brave content).
//
//   node packages/adblock/scripts/assemble-resources.mjs [ubo-tag]

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UBO_TAG = process.argv[2] ?? "1.75.0";
const UBO_RAW = `https://raw.githubusercontent.com/gorhill/uBlock/${UBO_TAG}/`;
const BRAVE_RESOURCES = "https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
// adblock-rust permission bit for uBO's "trusted" scriptlets; only uBO's own lists are given it (see blocker.rs).
const TRUSTED = 0b1;

const MIME_BY_EXTENSION = {
  js: "application/javascript",
  css: "text/css",
  gif: "image/gif",
  png: "image/png",
  html: "text/html",
  json: "application/json",
  mp3: "audio/mp3",
  mp4: "video/mp4",
  txt: "text/plain",
  xml: "text/xml",
};

async function fetchOk(url, as = "text") {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return as === "text" ? response.text() : Buffer.from(await response.arrayBuffer());
}

/** Downloads a uBO module and every module it imports, keeping the repository layout under `root`. */
async function fetchModuleTree(root, path, seen = new Set()) {
  if (seen.has(path)) return;
  seen.add(path);
  const source = await fetchOk(UBO_RAW + path);
  await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(join(root, path), source);
  const imports = [...source.matchAll(/(?:from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => match[1]);
  await Promise.all(imports.map((specifier) => fetchModuleTree(root, posix.normalize(posix.join(posix.dirname(path), specifier)), seen)));
}

async function scriptletResources(root) {
  await fetchModuleTree(root, "src/js/resources/scriptlets.js");
  await import(pathToFileURL(join(root, "src/js/resources/scriptlets.js")).href);
  const { registeredScriptlets } = await import(pathToFileURL(join(root, "src/js/resources/base.js")).href);
  return registeredScriptlets.map((details) => {
    const source = details.fn.toString();
    // adblock-rust calls a scriptlet by its function name; helpers (`*.fn`, functions or classes) are only pasted in.
    const helper = details.name.endsWith(".fn");
    if (!helper && !/^function\s+[^\s(){}]+\s*\(/.test(source)) throw new Error(`${details.name} isn't a named function`);
    return {
      name: details.name,
      aliases: details.aliases ?? [],
      kind: { mime: helper ? "fn/javascript" : "application/javascript" },
      content: Buffer.from(source).toString("base64"),
      dependencies: details.dependencies ?? [],
      permission: details.requiresTrust ? TRUSTED : 0,
    };
  });
}

async function redirectResources(root) {
  await fetchModuleTree(root, "src/js/redirect-resources.js");
  const { default: map } = await import(pathToFileURL(join(root, "src/js/redirect-resources.js")).href);
  const resources = [];
  for (const [name, details] of map) {
    // `empty` (an empty response) has no extension.
    const mime = name.includes(".") ? MIME_BY_EXTENSION[name.split(".").pop()] : "text/plain";
    if (!mime) {
      console.warn(`skipped ${name}: no MIME type for it`);
      continue;
    }
    try {
      const content = await fetchOk(`${UBO_RAW}src/web_accessible_resources/${name}`, "bytes");
      const alias = details.alias ?? [];
      resources.push({ name, aliases: Array.isArray(alias) ? alias : [alias], kind: { mime }, content: content.toString("base64") });
    } catch (error) {
      console.warn(`skipped ${name}: ${error.message}`);
    }
  }
  return resources;
}

const root = await mkdtemp(join(tmpdir(), "bay-ubo-"));
try {
  const scriptlets = await scriptletResources(root);
  const redirects = await redirectResources(root);
  const brave = JSON.parse(await fetchOk(BRAVE_RESOURCES));
  const byName = new Map();
  for (const resource of [...scriptlets, ...redirects, ...brave]) if (!byName.has(resource.name)) byName.set(resource.name, resource);
  const resources = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "resources.json"), `${JSON.stringify(resources)}\n`);
  await writeFile(
    join(OUT, "SOURCES"),
    `uBlock Origin ${UBO_TAG} (GPLv3): ${scriptlets.length} scriptlets and helpers, ${redirects.length} redirect resources\n` +
      `brave/adblock-resources (MPL-2.0): ${brave.length} resources\n`,
  );
  console.log(`wrote ${resources.length} resources (${scriptlets.length} scriptlets, ${redirects.length} redirects, ${brave.length} Brave)`);
} finally {
  await rm(root, { recursive: true, force: true });
}
