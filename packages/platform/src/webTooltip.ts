const styleId = "bay-view-tooltips";
const ownerAttribute = "data-bay-tooltip";

const controls =
  'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

const bindings = new WeakMap<HTMLElement, TooltipBinding>();
const managers = new WeakMap<Document, TooltipManager>();
let nextId = 1;

type TooltipBinding = {
  node: HTMLElement;
  label: string;
  hovered: boolean;
  focused: HTMLElement | null;
  labelled: HTMLElement | null;
  refresh: () => void;
  dispose: () => void;
};

function control(node: HTMLElement): HTMLElement {
  if (node.matches(controls)) return node;
  const children = node.querySelectorAll<HTMLElement>(controls);

  return children.length === 1 ? children[0]! : node;
}

function describe(node: HTMLElement, id: string, add: boolean) {
  const ids = new Set((node.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));

  if (add) ids.add(id);
  else ids.delete(id);

  if (ids.size) node.setAttribute("aria-describedby", [...ids].join(" "));
  else node.removeAttribute("aria-describedby");
}

function installStyle(document: Document) {
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
[data-bay-tooltip-layer] {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  max-width: min(320px, calc(100vw - 16px));
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  border-radius: 5px;
  color: CanvasText;
  background: Canvas;
  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: pre-line;
  overflow-wrap: anywhere;
  box-shadow: 0 2px 8px #0003;
  -webkit-app-region: no-drag;
}
`;
  document.head.appendChild(style);
}

class TooltipManager {
  readonly element: HTMLDivElement;
  private active: TooltipBinding | null = null;
  private target: HTMLElement | null = null;
  private pending: TooltipBinding | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private overTooltip = false;
  private removeListeners: (() => void) | undefined;
  private readonly document: Document;

  constructor(document: Document) {
    this.document = document;
    installStyle(document);
    this.element = document.createElement("div");
    this.element.id = `bay-tooltip-${nextId++}`;
    this.element.setAttribute("role", "tooltip");
    this.element.setAttribute("data-bay-tooltip-layer", "");
    this.element.addEventListener("mouseenter", () => {
      this.overTooltip = true;
      clearTimeout(this.hideTimer);
    });
    this.element.addEventListener("mouseleave", () => {
      this.overTooltip = false;

      if (this.active && !this.active.hovered && !this.active.focused) this.hide();
    });
  }
  request(binding: TooltipBinding, immediate: boolean) {
    clearTimeout(this.timer);
    clearTimeout(this.hideTimer);
    this.pending = binding;

    if (immediate) this.show(binding);
    else this.timer = setTimeout(() => this.show(binding), 500);
  }
  leave(binding: TooltipBinding) {
    if (this.pending === binding) {
      clearTimeout(this.timer);
      this.pending = null;
    }

    if (this.active !== binding || binding.focused || binding.hovered) return;
    // Keep the label readable when the pointer crosses from its control to it.
    this.hideTimer = setTimeout(() => {
      if (!this.overTooltip && this.active === binding && !binding.focused && !binding.hovered) this.hide();
    }, 120);
  }
  refresh(binding: TooltipBinding) {
    if (this.active === binding) this.show(binding);
  }
  remove(binding: TooltipBinding) {
    if (this.pending === binding) {
      clearTimeout(this.timer);
      this.pending = null;
    }

    if (this.active === binding) this.hide();
  }
  private show(binding: TooltipBinding) {
    this.pending = null;

    if (!binding.label || !binding.node.isConnected) return;
    this.hide();
    this.active = binding;
    this.target = binding.focused ?? control(binding.node);
    this.element.textContent = binding.label;
    this.document.body.appendChild(this.element);
    const rect = binding.node.getBoundingClientRect();
    const tooltip = this.element.getBoundingClientRect();
    const width = this.document.documentElement.clientWidth;
    const height = this.document.documentElement.clientHeight;
    const left = Math.max(8, Math.min(rect.left + (rect.width - tooltip.width) / 2, width - tooltip.width - 8));
    const top = rect.bottom + tooltip.height + 8 <= height ? rect.bottom + 6 : Math.max(8, rect.top - tooltip.height - 6);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    describe(this.target, this.element.id, true);
    const dismiss = () => this.hide();

    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.hide();
    };

    const document = this.document;
    const window = document.defaultView;
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    window?.addEventListener("resize", dismiss);
    window?.addEventListener("blur", dismiss);
    this.removeListeners = () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      window?.removeEventListener("resize", dismiss);
      window?.removeEventListener("blur", dismiss);
    };
  }
  private hide() {
    clearTimeout(this.timer);
    clearTimeout(this.hideTimer);
    this.pending = null;
    this.removeListeners?.();
    this.removeListeners = undefined;

    if (this.target) describe(this.target, this.element.id, false);
    this.target = null;
    this.active = null;
    this.overTooltip = false;
    this.element.remove();
  }
}

/** One live tooltip per document, with listeners only on views that have a label. */
export function setWebTooltip(node: HTMLElement, label?: string) {
  if (!label) {
    removeWebTooltip(node);

    return;
  }

  const existing = bindings.get(node);

  if (existing) {
    const previous = existing.label;
    existing.label = label;

    if (existing.labelled?.getAttribute("aria-label") === previous) existing.labelled.setAttribute("aria-label", label);
    existing.refresh();

    return;
  }

  let manager = managers.get(node.ownerDocument);

  if (!manager) {
    manager = new TooltipManager(node.ownerDocument);
    managers.set(node.ownerDocument, manager);
  }

  node.setAttribute(ownerAttribute, "");
  // A wrapper tooltip can also name its sole icon button. Never replace the
  // name chosen by a control or label an already-labelled text control.
  const candidate = control(node);

  const labelled =
    candidate.matches(controls) && !candidate.getAttribute("aria-label") && !candidate.getAttribute("aria-labelledby") && !candidate.textContent?.trim()
      ? candidate
      : null;

  labelled?.setAttribute("aria-label", label);

  const binding: TooltipBinding = {
    node,
    label,
    labelled,
    hovered: false,
    focused: null,
    refresh: () => manager.refresh(binding),
    dispose: () => {
      manager.remove(binding);
      node.removeAttribute(ownerAttribute);

      if (binding.labelled?.getAttribute("aria-label") === binding.label) binding.labelled.removeAttribute("aria-label");
      node.removeEventListener("mouseenter", enter);
      node.removeEventListener("mouseleave", leave);
      node.removeEventListener("focusin", focus);
      node.removeEventListener("focusout", blur);
    },
  };

  const enter = () => {
    binding.hovered = true;
    manager.request(binding, false);
  };

  const leave = () => {
    binding.hovered = false;
    manager.leave(binding);
  };

  const focus = (event: FocusEvent) => {
    // SAFETY: the checks above established this shape.
    const target = event.target as HTMLElement;

    if (target.closest(`[${ownerAttribute}]`) !== node) return;
    binding.focused = target;
    manager.request(binding, true);
  };

  const blur = (event: FocusEvent) => {
    // SAFETY: the checks above established this shape.
    if (event.relatedTarget && node.contains(event.relatedTarget as Node)) return;
    binding.focused = null;
    manager.leave(binding);
  };

  node.addEventListener("mouseenter", enter);
  node.addEventListener("mouseleave", leave);
  node.addEventListener("focusin", focus);
  node.addEventListener("focusout", blur);
  bindings.set(node, binding);
}

export function removeWebTooltip(node: HTMLElement) {
  bindings.get(node)?.dispose();
  bindings.delete(node);
}
