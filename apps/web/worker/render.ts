import type { Snapshot } from "./payload.ts";

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function render(snapshot: Snapshot | null): string {
  const title = snapshot?.title || (snapshot ? "Untitled Easel" : "Easel unavailable");
  const sources = snapshot?.links
    .map((link) => `<li><a href="${escape(link.url)}" rel="noreferrer noopener nofollow">${escape(link.title || link.url)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${escape(title)} · Bay</title><style>
*{box-sizing:border-box}body{margin:0;color:#253c39;background:#faf9f5;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.6}
header,main,footer{width:min(1120px,calc(100% - 48px));margin:auto}header{padding:28px 0;border-bottom:1px solid #dedfd7;display:flex;align-items:center;justify-content:space-between;gap:16px}
a{color:inherit;text-underline-offset:4px;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #3a766b;outline-offset:5px}.brand{font-size:24px;font-weight:750;text-decoration:none;letter-spacing:-1px}
.note{font-size:14px;color:#53645d}h1{font-family:Georgia,serif;font-weight:400;font-size:clamp(32px,5vw,56px);line-height:1.15;letter-spacing:-1px;margin:40px 0 28px;overflow-wrap:anywhere}
.canvas{background:${snapshot?.background || "#f0eee7"};border-radius:12px;overflow:hidden;min-height:120px}.canvas img{display:block;width:100%;height:auto}.empty{padding:48px 24px;text-align:center;color:#253c39;background:#f0eee7}
.sources{max-width:760px;margin:36px 0 48px}h2{font-size:20px;font-weight:600;margin:0 0 12px}ol{padding-left:24px}li{padding:6px 0}footer{border-top:1px solid #dedfd7;padding:20px 0 32px;font-size:14px;color:#53645d}
@media(max-width:600px){header,main,footer{width:calc(100% - 32px)}header{padding:20px 0}h1{margin-top:28px}.note{font-size:12px}.canvas{border-radius:8px}}
</style></head><body><header><a class="brand" href="/" rel="noreferrer">Bay</a><span class="note">Shared snapshot</span></header>
<main><h1>${escape(title)}</h1>${
    snapshot
      ? `${
          snapshot.image
            ? `<div class="canvas"><img src="${snapshot.image.data}" width="${snapshot.image.width}" height="${snapshot.image.height}" alt="${escape(title)}"></div>`
            : `<div class="canvas"><p class="empty">This Easel has no image.</p></div>`
        }
<section class="sources" aria-label="Sources"><h2>Sources</h2>${sources ? `<ol>${sources}</ol>` : "<p>No sources in this snapshot.</p>"}</section>`
      : "<p>This shared Easel does not exist or is no longer shared.</p>"
  }</main>
<footer>A shared snapshot from Bay. Changes to the original Easel appear here only when its owner shares again.</footer></body></html>`;
}
