import { ARTICLE_HELPERS } from "./article.ts";
import { READABILITY, TURNDOWN } from "./vendor.generated.ts";

/**
 * Copy as Markdown: the page's article (Readability, falling back to the whole body) converted by Turndown, headed by
 * its title and followed by its address. Resolves `{ markdown }`.
 */
export const MARKDOWN_SCRIPT = `
const state = (window[Symbol.for("bay.markdown")] ??= {});
state.Readability ??= ${READABILITY};
state.Turndown ??= ${TURNDOWN};
${ARTICLE_HELPERS}
const source = clonePage();
const article = new state.Readability(source.cloneNode(true), { charThreshold: 400 }).parse();
const html = article && article.content ? article.content : source.body?.innerHTML || "";
const title = (article && article.title) || document.title;
const turndown = new state.Turndown({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
turndown.remove(["script", "style", "noscript", "iframe"]);
const body = turndown.turndown(safeArticle(html)).trim();
return { markdown: (title ? "# " + title + "\\n\\n" : "") + body + "\\n\\n" + location.href + "\\n" };
`;
