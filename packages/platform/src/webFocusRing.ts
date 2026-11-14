const styleId = "bay-view-focus-rings";
const noRing = "data-bay-no-focus-ring";
const tabbing = "data-bay-tabbing";

// One stylesheet, so a view needs nothing unless it opts out. A ring shows only while someone moves through the window
// with Tab: Chromium's :focus-visible alone also lights up whatever code focuses after any key or at launch, which drew
// a ring around the selected tab. Text fields show their caret instead, as the app's own fields do on macOS. A page
// draws its own focus, and tabindex -1 is focus moved by code, which a person didn't tab to.
const rings = `
html[${tabbing}] :focus-visible:not(embed):not(input):not(textarea):not(select):not([tabindex="-1"]) {
  outline: 2px solid Highlight !important;
  outline-offset: 2px !important;
}
html:not([${tabbing}]) :focus-visible:not(embed),
input:focus,
textarea:focus,
select:focus,
[${noRing}]:focus {
  outline: none !important;
}
`;

function watchTabbing(document: Document) {
  const root = document.documentElement;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) root.setAttribute(tabbing, "");
    },
    true,
  );
  document.addEventListener("pointerdown", () => root.removeAttribute(tabbing), true);
}

/** `enableFocusRing`: a view draws its own focus when it's false. */
export function setWebFocusRing(node: HTMLElement, enabled = true) {
  const document = node.ownerDocument;

  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = rings;
    document.head.appendChild(style);
    watchTabbing(document);
  }

  if (enabled) node.removeAttribute(noRing);
  else node.setAttribute(noRing, "");
}
