/** An invisible element that holds keyboard focus in this document, so its keys come here rather than to a page. */
export function createFocusHolder(doc: Pick<Document, "createElement" | "body">): HTMLElement {
  const holder = doc.createElement("div");
  holder.tabIndex = -1;
  holder.setAttribute("aria-hidden", "true");
  Object.assign(holder.style, { position: "fixed", width: "0", height: "0", overflow: "hidden", outline: "none" });
  doc.body.append(holder);
  return holder;
}
