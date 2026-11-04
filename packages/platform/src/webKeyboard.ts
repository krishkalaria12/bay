import type { KeyDownEventSpec } from "./viewTypes";
const aliases: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Return: "Enter", " ": "Space" };
const canonical = (value: string): string => (aliases[value] ?? value).toLowerCase();
export const keyCode = (key: string): string => (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : (aliases[key] ?? key));
export function webKeyMatches(spec: KeyDownEventSpec, event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return (
    canonical(spec.key) === canonical(event.key) &&
    !!spec.ctrlKey === event.ctrlKey &&
    !!spec.metaKey === event.metaKey &&
    !!spec.altKey === event.altKey &&
    !!spec.shiftKey === event.shiftKey
  );
}

type KeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">;
type KeyClaims = () => readonly KeyDownEventSpec[] | undefined;
const claims = new WeakMap<object, KeyClaims>();

/** The keys a view takes (its `keyDownEvents`), so a window shortcut can give way to them in a text field. */
export const setKeyClaims = (node: object, read: KeyClaims) => void claims.set(node, read);

/** Whether the event's target, or a view around it, takes this key itself. */
export function webKeyClaimed(event: KeyEvent): boolean {
  for (let node = event.target as Element | null; node; node = node.parentElement) {
    if (
      claims
        .get(node)?.()
        ?.some((spec) => webKeyMatches(spec, event))
    )
      return true;
  }
  return false;
}
