export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface Snapshot {
  version: 1;
  revision: number;
  title: string;
  background: string;
  image: { data: string; width: number; height: number } | null;
  links: { title: string; url: string }[];
}

export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function invalid(): never {
  throw new RequestError(400, "Invalid snapshot.");
}

function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key))) invalid();
}

function png(image: Record<string, unknown>): void {
  const { data, width, height } = image;
  if (
    typeof data !== "string" ||
    !data.startsWith("data:image/png;base64,") ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (width as number) > 16384 ||
    (height as number) > 16384 ||
    (width as number) * (height as number) > 33_000_000
  )
    invalid();
  const encoded = data.slice(22);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid();
  let bytes: string;
  try {
    bytes = atob(encoded);
  } catch {
    invalid();
  }
  // Check the PNG signature and IHDR dimensions without decoding untrusted pixels.
  if (bytes.length < 45 || bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || bytes.slice(8, 16) !== "\0\0\0\rIHDR" || bytes.slice(-8, -4) !== "IEND") invalid();
  const uint32 = (offset: number) =>
    bytes.charCodeAt(offset) * 0x1000000 + bytes.charCodeAt(offset + 1) * 0x10000 + bytes.charCodeAt(offset + 2) * 0x100 + bytes.charCodeAt(offset + 3);
  if (uint32(16) !== width || uint32(20) !== height) invalid();
}

export function validateSnapshot(value: unknown): Snapshot {
  fields(value, ["version", "revision", "title", "background", "image", "links"]);
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.title !== "string" ||
    typeof value.background !== "string" ||
    !/^#[0-9a-fA-F]{6}$/.test(value.background) ||
    !Array.isArray(value.links)
  )
    invalid();
  if (value.image !== null) {
    fields(value.image, ["data", "width", "height"]);
    png(value.image);
  }
  for (const link of value.links) {
    fields(link, ["title", "url"]);
    // Control characters and backslashes can change the URL a browser actually opens.
    if (
      typeof link.title !== "string" ||
      typeof link.url !== "string" ||
      !/^https?:\/\//i.test(link.url) ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0020\u007f\\]/.test(link.url)
    )
      invalid();
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      invalid();
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) invalid();
  }
  return value as unknown as Snapshot;
}

export async function readSnapshot(request: Request): Promise<Snapshot> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "Expected application/json.");
  }
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new RequestError(413, "Snapshot exceeds 16 MiB.");
  }
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pieces: string[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RequestError(413, "Snapshot exceeds 16 MiB.");
      }
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "Invalid request body.");
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(pieces.join(""));
  } catch {
    invalid();
  }
  return validateSnapshot(value);
}
