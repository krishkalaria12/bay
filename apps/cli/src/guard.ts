// `bay exec` never quits, crashes or reloads the browser: it is the user's own Bay.
const FORBIDDEN_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);

export class ForbiddenCommand extends Error {
  override name = "ForbiddenCommand";
}

export function checkMethod(method: unknown): void {
  if (typeof method === "string" && FORBIDDEN_METHODS.has(method)) {
    throw new ForbiddenCommand(`bay exec never sends ${method}: it's the user's browser`);
  }
}

export function checkCommand(command: unknown): void {
  if (typeof command === "object" && command !== null && !Array.isArray(command)) checkMethod((command as { method?: unknown }).method);
}

/** Every message the client sends is whole JSON, and none of its commands may stop Bay. */
export function checkMessage(message: string | Uint8Array): void {
  let text: string;
  if (typeof message === "string") text = message;
  else if (message instanceof Uint8Array) text = new TextDecoder().decode(message);
  else return;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ForbiddenCommand("bay exec only sends JSON commands");
  }
  if (Array.isArray(payload)) for (const command of payload) checkCommand(command);
  else checkCommand(payload);
}
