// Where windows can't be placed on screen (Wayland), a dragged tab can't float a preview window, so its card is drawn in
// the window it came from: enough to show what a drop on the page will take, and gone at the window's edge.

const WIDTH = 209;
const HEIGHT = 110;

let card: { element: HTMLElement; title: HTMLElement; icon: HTMLImageElement } | null = null;

function make(document: Document) {
  const element = document.createElement("div");
  Object.assign(element.style, {
    position: "fixed",
    width: `${WIDTH}px`,
    height: `${HEIGHT}px`,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    padding: "12px",
    borderRadius: "4px",
    border: "1px solid #ffffff4d",
    background: "#202022",
    color: "#fff",
    font: "13px system-ui, sans-serif",
    textAlign: "center",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "2147483646",
  });
  const icon = document.createElement("img");
  Object.assign(icon.style, { width: "32px", height: "32px" });
  const title = document.createElement("div");
  element.append(icon, title);
  document.body.append(element);
  return { element, title, icon };
}

/** The card centred on the pointer, as the floating one is. */
export function showDragCard(pointer: [number, number], title: string, favicon: string | null | undefined, document: Document = globalThis.document) {
  card ??= make(document);
  card.title.textContent = title;
  card.icon.style.display = favicon ? "" : "none";
  if (favicon && card.icon.src !== favicon) card.icon.src = favicon;
  card.element.style.left = `${pointer[0] - WIDTH / 2}px`;
  card.element.style.top = `${pointer[1] - HEIGHT / 2}px`;
}

export function hideDragCard() {
  card?.element.remove();
  card = null;
}
