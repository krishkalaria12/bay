import type { JsonInput, JsonValue } from "../lib/json";

/** Window-only transport. The coordinator never installs this client. */
export type ServiceDispatch = (action: string, args: JsonInput[]) => Promise<JsonValue>;

let client: ServiceDispatch | undefined;
export const hasServiceClient = () => !!client;

export function installServiceClient(dispatch: ServiceDispatch): () => void {
  if (client) throw new Error("Service command client is already installed");
  client = dispatch;

  return () => {
    if (client === dispatch) client = undefined;
  };
}

export function requestService<T>(action: string, args: JsonInput[] = []): Promise<T> {
  if (!client) return Promise.reject(new Error("Service command client is unavailable"));

  // SAFETY: the checks above established this shape.
  return client(action, args) as Promise<T>;
}

export function sendService(action: string, args: JsonInput[] = []): boolean {
  if (!client) return false;
  void client(action, args).catch((error) => console.error("Service command failed", action, error));

  return true;
}
