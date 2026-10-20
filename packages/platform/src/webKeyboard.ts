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
