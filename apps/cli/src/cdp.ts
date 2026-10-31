import { checkMessage } from "./guard.ts";

export class CdpError extends Error {
  override name = "CdpError";
}

export class ConnectionLost extends Error {
  override name = "ConnectionLost";
}

export type CdpListener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

type Waiting = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const OPEN = 1;

/** One Chrome DevTools Protocol connection to Bay's browser process, with flat sessions for its tabs. */
export class Cdp {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners = new Set<CdpListener>();
  private closedFlag = false;
  private readonly closedWaiters = new Set<() => void>();

  constructor(readonly url: string) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  async open(timeoutMs: number): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.markClosed());
    socket.addEventListener("error", () => this.markClosed());
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error(`no answer in ${formatSeconds(timeoutMs)}`)), timeoutMs);
        socket.addEventListener("open", () => finish(), { once: true });
        socket.addEventListener("error", () => finish(new Error("the connection failed")), { once: true });
        socket.addEventListener("close", () => finish(new Error("the connection closed")), { once: true });
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    if (this.closedFlag) throw new Error("the connection closed");
  }

  addListener(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when the connection ends, however it ends: the browser quit, crashed, or the socket dropped. */
  whenClosed(): Promise<void> {
    if (this.closedFlag) return Promise.resolve();
    return new Promise((resolve) => this.closedWaiters.add(resolve));
  }

  async send(method: string, params: Record<string, unknown> = {}, session?: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.closedFlag) throw new ConnectionLost();
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) throw new ConnectionLost();
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (session) message.sessionId = session;
    const text = JSON.stringify(message);
    checkMessage(text);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiting.delete(id);
              reject(new CdpError(`${method} got no answer in ${formatSeconds(timeoutMs)}`));
            }, timeoutMs)
          : null;
      this.waiting.set(id, { resolve, reject, timer });
      try {
        socket.send(text);
      } catch (error) {
        this.waiting.delete(id);
        if (timer) clearTimeout(timer);
        reject(this.closedFlag ? new ConnectionLost() : new CdpError(`${method}: ${messageOf(error)}`));
      }
    });
    const error = reply.error;
    if (error && typeof error === "object") {
      const text = (error as { message?: unknown }).message;
      throw new CdpError(typeof text === "string" && text ? text : `${method} failed`);
    }
    const result = reply.result;
    return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.markClosed();
    if (!socket) return;
    try {
      socket.close();
    } catch {}
  }

  private onMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (data instanceof Uint8Array) text = new TextDecoder().decode(data);
    else return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiting = this.waiting.get(message.id);
      if (!waiting) return;
      this.waiting.delete(message.id);
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.resolve(message);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(message.method, params, sessionId);
      } catch {}
    }
  }

  private markClosed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const waiting of this.waiting.values()) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new ConnectionLost());
    }
    this.waiting.clear();
    for (const waiter of this.closedWaiters) waiter();
    this.closedWaiters.clear();
  }
}

export function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(3))}s`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
