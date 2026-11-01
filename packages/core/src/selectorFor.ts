// Zen Browser's element selector builder (src/zen/boosts/ZenSelectorComponent.sys.mjs › getSelectionPath), shared by
// desktop Boosts' picker and mobile's Hide elements. Mozilla Public License 2.0: https://mozilla.org/MPL/2.0/ (this file
// stays under the MPL-2.0).
//
// Zen's getSelectionPath. related: 0 the element itself (the shortest of three candidate paths), 1 its parent, 2 its
// kind under the same parent, 3 its kind under parents of that kind, 4 its kind anywhere, 5 its parent's kind, 6
// everything under its parent, 7 elements with its classes.
/** Page-script source defining `selectorFor(element, related)`. No backticks inside: it is one string. */
export const SELECTOR_FOR = String.raw`
const selectorFor = (element, related) => {
  const isValidNode = (el) => !!el && el.nodeType === 1 && !/^(body|html)$/i.test(el.tagName);
  const nthChild = (el) => {
    if (!el || !el.parentNode || !el.parentNode.children) return "";
    const parent = el.parentNode;
    const index = Array.prototype.indexOf.call(parent.children, el) + 1;
    if (index === 1) return ":first-child";
    if (index === parent.children.length) return ":last-child";
    return ":nth-child(" + index + ")";
  };
  const identify = (el, specificity) => {
    if (!el || el.nodeType !== 1) return "";
    const id = specificity < 2 && el.id ? "#" + CSS.escape(el.id) : "";
    const cls = specificity < 1 && el.classList.length ? "." + Array.from(el.classList).map((c) => CSS.escape(c)).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const build = (parts) => parts.slice().reverse().join("");
  const count = (sel) => {
    try {
      return sel ? document.querySelectorAll(sel).length : 0;
    } catch (e) {
      return Infinity;
    }
  };
  const traverse = (el, specificity, parts) => {
    let current = el;
    if (!isValidNode(current)) return;
    parts.push(nthChild(current));
    parts.push(identify(current, specificity));
    if (current.parentNode && current.parentNode.nodeType === 1) {
      parts.push(" > ");
      parts.push(identify(current.parentNode, 0));
      let built = build(parts);
      while (built && count(built) > 1 && isValidNode(current.parentNode)) {
        current = current.parentNode;
        parts.push(" > ");
        parts.push(nthChild(current.parentNode));
        parts.push(identify(current.parentNode, 0));
        built = build(parts);
      }
    }
  };
  const bestExact = (el) => {
    const candidates = new Map();
    const exact = [];
    traverse(el, 0, exact);
    candidates.set(count(build(exact)), build(exact));
    const byType = [identify(el, 2)];
    if (isValidNode(el.parentNode)) {
      byType.push(" > ");
      traverse(el.parentNode, 0, byType);
    }
    const typeLength = count(build(byType));
    if (!candidates.has(typeLength)) candidates.set(typeLength, build(byType));
    let smallest = Infinity, best = null;
    candidates.forEach((sel, n) => {
      if (n >= 1 && n < smallest) {
        smallest = n;
        best = sel;
      }
    });
    return best || build(exact);
  };
  if (!isValidNode(element)) return null;
  const parts = [];
  switch (related) {
    case 1:
      if (!isValidNode(element.parentNode)) return null;
      traverse(element.parentNode, 0, parts);
      break;
    case 2:
      parts.push(identify(element, 2));
      if (isValidNode(element.parentNode)) {
        parts.push(" > ");
        parts.push(identify(element.parentNode, 0));
      }
      break;
    case 3:
      parts.push(identify(element, 2));
      if (isValidNode(element.parentNode)) {
        parts.push(" > ");
        parts.push(identify(element.parentNode, 2));
      }
      break;
    case 4:
      parts.push(identify(element, 2));
      break;
    case 5:
      if (!isValidNode(element.parentNode)) return null;
      parts.push(identify(element.parentNode, 2));
      break;
    case 6:
      if (!isValidNode(element.parentNode)) return null;
      parts.push("*");
      parts.push(" > ");
      traverse(element.parentNode, 0, parts);
      break;
    case 7:
      parts.push(identify(element, 1));
      break;
    default:
      return bestExact(element);
  }
  return build(parts) || null;
};`;
