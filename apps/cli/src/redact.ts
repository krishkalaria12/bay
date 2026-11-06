import { StringDecoder } from "node:string_decoder";
import * as v from "valibot";

// Secrets never reach the terminal: the control file's token is added as soon as it's read, and every write to
// stdout or stderr goes through the redactor. A secret split across two writes is held back until it's whole.
const MASK = "***";
const TOKEN_QUERY = /(token=)[^&\s'"<>]+/g;

const secrets = new Set<string>();
let installed = false;
const drains: Array<() => void> = [];

export function addSecret(secret: string | null | undefined): void {
  if (!secret) return;
  secrets.add(secret);
  secrets.add(encodeURIComponent(secret));
}

export function redact(text: string): string {
  let out = text;

  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join(MASK);

  return out.replace(TOKEN_QUERY, `$1${MASK}`);
}

function unsafeTail(text: string): number {
  let keep = 0;

  for (const secret of secrets) {
    for (let size = Math.min(secret.length - 1, text.length); size > keep; size -= 1) {
      if (text.endsWith(secret.slice(0, size))) {
        keep = size;
        break;
      }
    }
  }

  return keep;
}

export class RedactingStream {
  private pending = "";

  constructor(private readonly write: (text: string) => void) {}

  push(text: string): void {
    const cleaned = redact(this.pending + text);
    const keep = unsafeTail(cleaned);
    const ready = keep ? cleaned.slice(0, -keep) : cleaned;
    this.pending = keep ? cleaned.slice(-keep) : "";

    if (ready) this.write(ready);
  }

  drain(): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = "";
      this.write(redact(pending));
    }
  }
}

type WriteCallback = (error?: Error | null) => void;

const BUFFER_ENCODINGS = ["ascii", "utf8", "utf-8", "utf16le", "utf-16le", "latin1", "binary", "base64", "base64url", "hex", "ucs2", "ucs-2"] as const;
const BufferEncodingSchema = v.picklist(BUFFER_ENCODINGS);

/** The encoding a `write` call named, or UTF-8 when it named a callback in its place. */
function bufferEncoding(encoding: BufferEncoding | WriteCallback | undefined): BufferEncoding {
  return v.is(BufferEncodingSchema, encoding) ? encoding : "utf8";
}

/** A `write` replacement that pushes its output through the redactor, keeping node's callback and return contract. */
function redactingWriter(stream: RedactingStream, decoder: StringDecoder): typeof process.stdout.write {
  return (chunk: string | Uint8Array, encoding?: BufferEncoding | WriteCallback, done?: WriteCallback): boolean => {
    const bytes = v.is(v.string(), chunk) ? Buffer.from(chunk, bufferEncoding(encoding)) : Buffer.from(chunk);

    stream.push(decoder.write(bytes));

    const callback = v.is(v.function_(), encoding) ? encoding : done;

    if (v.is(v.function_(), callback)) queueMicrotask(() => callback());

    return true;
  };
}

/** Rewrites what the process itself writes to its terminal through the redactor. Safe to call more than once. */
export function installOutputRedaction(): void {
  if (installed) return;
  installed = true;
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const stdout = new RedactingStream((text) => void writeOut(text));
  const stderr = new RedactingStream((text) => void writeErr(text));
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  drains.push(() => {
    stdout.push(outDecoder.end());
    stderr.push(errDecoder.end());
    stdout.drain();
    stderr.drain();
  });
  process.stdout.write = redactingWriter(stdout, outDecoder);
  process.stderr.write = redactingWriter(stderr, errDecoder);
  process.on("exit", () => {
    for (const drain of drains) drain();
  });
}

/** Flushes every stream the redactor holds back. */
export function drainOutput(): void {
  for (const drain of drains) drain();
}
