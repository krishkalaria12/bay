// adblock-rust recommends converting modern uBO resources through their exported JS registry, rather than parsing
// function source files. This program imports only the archive that blocker-resources.sh verifies against its pin.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceArg, output] = process.argv.slice(2);
assert.ok(sourceArg && output, "usage: blocker-resources.mjs <verified uBO release directory> <output JSON>");
const source = resolve(sourceArg);
const { builtinScriptlets } = await import(pathToFileURL(join(source, "js/resources/scriptlets.js")));
const { default: redirects } = await import(pathToFileURL(join(source, "js/redirect-resources.js")));
const mime = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mp3": "audio/mp3",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".txt": "text/plain",
  ".xml": "text/xml",
};
const aliases = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const resources = [];
for (const [name, details] of redirects) {
  const body = await readFile(join(source, "web_accessible_resources", name));
  resources.push({
    name,
    aliases: aliases(details.alias),
    kind: { mime: mime[extname(name)] ?? "application/octet-stream" },
    content: body.toString("base64"),
    permission: details.requiresTrust ? 1 : 0,
  });
}
for (const details of builtinScriptlets) {
  assert.equal(typeof details.fn, "function", `resource ${details.name} must have a function or class`);
  resources.push({
    name: details.name,
    aliases: aliases(details.aliases),
    kind: { mime: details.name.endsWith(".fn") ? "fn/javascript" : "application/javascript" },
    content: Buffer.from(details.fn.toString()).toString("base64"),
    dependencies: details.dependencies ?? [],
    permission: details.requiresTrust ? 1 : 0,
  });
}
const names = new Set();
for (const resource of resources) {
  for (const name of [resource.name, ...resource.aliases]) {
    assert.ok(!names.has(name), `duplicate resource name or alias: ${name}`);
    names.add(name);
  }
}
for (const resource of resources) {
  for (const dependency of resource.dependencies ?? []) assert.ok(names.has(dependency), `missing dependency ${dependency}`);
}
assert.ok(resources.length > 150, "the pinned catalogue must include scriptlets and redirect resources");
resources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
await writeFile(output, JSON.stringify(resources));
console.log(`Built ${resources.length} content blocker resources from the verified uBO release`);
