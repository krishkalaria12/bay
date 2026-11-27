// Readability extracts an article; it does not sanitize it. Recreate only reading markup from an inert document
// before putting it in the live page. No event attributes, custom elements, embedded frames or inline styles survive.
export const ARTICLE_HELPERS = String.raw`
const clonePage = () => {
  const copy = document.cloneNode(true);
  for (const tag of ["bay-reader", "bay-picker"]) {
    for (const el of Array.from(copy.getElementsByTagName(tag))) el.remove();
  }
  return copy;
};
const safeArticle = (html) => {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const allowed = new Set("a abbr article b blockquote br caption code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img li main mark ol p pre q s section small span strong sub summary sup table tbody td tfoot th thead time tr u ul".split(" "));
  const discard = new Set("script style noscript iframe object embed svg math form input button select textarea template link meta base".split(" "));
  const output = document.createElement("div");
  const copy = (node, parent) => {
    if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (discard.has(tag) || tag.includes("-")) return;
    const el = allowed.has(tag) ? document.createElement(tag) : null;
    if (el) {
      for (const attr of ["alt", "title", "lang", "dir", "colspan", "rowspan", "datetime"]) {
        if (node.hasAttribute(attr)) el.setAttribute(attr, node.getAttribute(attr));
      }
      const attr = tag === "a" ? "href" : tag === "img" ? "src" : null;
      if (attr && node.hasAttribute(attr)) {
        try {
          const url = new URL(node.getAttribute(attr), document.baseURI);
          if (["http:", "https:"].includes(url.protocol) || (tag === "a" && ["mailto:", "tel:"].includes(url.protocol))) el.setAttribute(attr, url.href);
        } catch {}
      }
      parent.appendChild(el);
    }
    for (const child of Array.from(node.childNodes)) copy(child, el || parent);
  };
  for (const child of Array.from(parsed.body.childNodes)) copy(child, output);
  return output;
};
`;
