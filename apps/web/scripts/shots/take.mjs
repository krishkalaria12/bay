// Retakes the website's screenshots of Bay into src/assets/shots:
//   node apps/web/scripts/shots/take.mjs [scene…]        (every scene without names)
// The app comes forward for about a second per shot, and the pointer leaves it so nothing shows as hovered.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../../../../scripts/lib/instance.mjs";
import { open, photograph, publish, windowsOf } from "./lib.mjs";
import { scenes } from "./scenes.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(web, "src/assets/shots");
const publicShots = join(web, "public/screenshots");
const names = process.argv.slice(2);

for (const name of names.length ? names : Object.keys(scenes)) {
  const scene = scenes[name];
  if (!scene) throw new Error(`no scene "${name}": ${Object.keys(scenes).join(", ")}`);
  const data = join(tmpdir(), `bay-shots-${name}`);
  const app = await open(scene.session, data);
  try {
    for (const shot of scene.shots) {
      if (shot.before) await app.eval(shot.before);
      await sleep(shot.settle ?? 3000);
      const [window] = windowsOf(app.pid);
      await photograph(app.pid, window, join(out, `${shot.file}.webp`), shot.crop);
      if (shot.publish) await publish(join(out, `${shot.file}.webp`), join(publicShots, `${shot.file}.jpg`));
      console.log(`${shot.file}.webp`);
    }
  } finally {
    await app.quit();
    rmSync(data, { recursive: true, force: true });
  }
}
