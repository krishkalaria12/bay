import * as v from "valibot";

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

/** What JSON.parse yields by the grammar: strings, numbers, booleans, null, and arrays/objects of those. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Parses the body's text as JSON; text that is not JSON cannot be a snapshot. */
function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch {
    invalid();
  }
}

// Exactly these keys, of these types: a snapshot missing one, or carrying another, is not readable.
const SnapshotSchema: v.GenericSchema<Snapshot> = v.strictObject({
  version: v.literal(1),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  title: v.string(),
  background: v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/)),
  image: v.nullable(
    v.strictObject({
      data: v.pipe(v.string(), v.startsWith("data:image/png;base64,")),
      width: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(16384)),
      height: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(16384)),
    }),
  ),
  links: v.array(v.strictObject({ title: v.string(), url: v.string() })),
});

type Png = NonNullable<Snapshot["image"]>;

function png(image: Png): void {
  const { data, width, height } = image;

  if (width * height > 33_000_000) invalid();
  const encoded = data.slice(22);

  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid();
  let bytes: string;

  try {
    bytes = atob(encoded);
  } catch {
    invalid();
  }

  const uint32 = (offset: number) =>
    bytes.charCodeAt(offset) * 0x1000000 + bytes.charCodeAt(offset + 1) * 0x10000 + bytes.charCodeAt(offset + 2) * 0x100 + bytes.charCodeAt(offset + 3);

  // Check the PNG signature and IHDR dimensions without decoding untrusted pixels.
  if (bytes.length < 45 || bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || bytes.slice(8, 16) !== "\0\0\0\rIHDR" || bytes.slice(-8, -4) !== "IEND") invalid();

  if (uint32(16) !== width || uint32(20) !== height) invalid();
}

export function validateSnapshot(value: JsonValue): Snapshot {
  const parsed = v.safeParse(SnapshotSchema, value);

  if (!parsed.success) invalid();
  const snapshot = parsed.output;

  if (snapshot.image !== null) png(snapshot.image);

  for (const link of snapshot.links) {
    // Control characters and backslashes can change the URL a browser actually opens.
    if (
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

  return snapshot;
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

  return validateSnapshot(parseJson(pieces.join("")));
}
