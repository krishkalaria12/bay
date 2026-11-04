const styleId = "bay-view-focus-rings";
const noRing = "data-bay-no-focus-ring";

// One stylesheet, so a view needs nothing unless it opts out, and the ring follows the browser's keyboard modality while
// focus stays on the same control. A text field shows it whenever it has focus, inside its edge, as desktop fields do.
// A page draws its own focus, and tabindex -1 is focus moved by code, which a person didn't tab to.
const rings = `
:focus-visible:not(embed):not([tabindex="-1"]) {
  outline: 2px solid Highlight !important;
  outline-offset: 2px !important;
}
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline-offset: -2px !important;
}
[${noRing}]:focus {
  outline: none !important;
}
`;

/** `enableFocusRing`: a view draws its own focus when it's false. */
export function setWebFocusRing(node: HTMLElement, enabled = true) {
  const document = node.ownerDocument;
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = rings;
    document.head.appendChild(style);
  }
  if (enabled) node.removeAttribute(noRing);
  else node.setAttribute(noRing, "");
}
