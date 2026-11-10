// Boots the built web app in headless Chromium, on each desktop's preview. Unit tests can't see a start-up failure: an
// import cycle, or a module that throws as it loads, passes all of them and leaves "Bay could not start" in every window.
//   node scripts/web-boot-test.mjs [path to chromium]   (after pnpm build:web)
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findChromium } from "../../../packages/shaders/scripts/browser.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
if (!existsSync(join(dist, "index.html"))) throw new Error("Nothing to boot: run pnpm build:web first");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".ttf": "font/ttf", ".woff2": "font/woff2" };

// Exercise the rendered images too: a successful boot can still leave every bundled icon broken.
const imageProbe = `<script>
(async () => {
  let images = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    images = Array.from(document.querySelectorAll('[data-expoimage] img[src]'));
    if (images.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const results = await Promise.allSettled(images.map(image => image.decode()));
  document.documentElement.setAttribute('data-bay-images',
    images.length && results.every(result => result.status === 'fulfilled') ? 'decoded' : 'failed');
})();
</script>`;

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
  const asked = normalize(join(dist, path));
  const file = asked.startsWith(dist) && existsSync(asked) && statSync(asked).isFile() ? asked : join(dist, "index.html");
  const body = readFileSync(file);
  response
    .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
    .end(extname(file) === ".html" ? body.toString().replace("</body>", `${imageProbe}</body>`) : body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = findChromium(process.argv[2]);
let failed = false;
for (const platform of ["linux", "windows"]) {
  const { stdout } = await promisify(execFile)(
    browser,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=20000", "--dump-dom", `http://localhost:${port}/?platform=${platform}`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const failure = /Bay could not start[^<]*/.exec(stdout)?.[0];
  // The views' own stylesheet and the sidebar's field: the app rendered, rather than only not failing.
  const rendered = stdout.includes("bay-view-focus-rings") && stdout.includes("Search or enter address");
  const imagesDecoded = stdout.includes('data-bay-images="decoded"');
  console.log(`${platform}: ${failure ?? (rendered ? "booted" : "rendered nothing")}, images ${imagesDecoded ? "decoded" : "failed"}`);
  if (failure || !rendered || !imagesDecoded) failed = true;
}
server.close();
process.exitCode = failed ? 1 : 0;
