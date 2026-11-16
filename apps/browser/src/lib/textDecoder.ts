// Hermes on macOS has TextEncoder but no TextDecoder, and Effect makes one as its modules load (effect/encoding/Hex,
// under Tracer): without it the app's JavaScript stopped at its first line. index.js imports this first. UTF-8 only,
// which is all Effect and the app decode; a runtime with its own TextDecoder keeps it.

type DecodeInput = ArrayBuffer | ArrayBufferView;

const REPLACEMENT = 0xfffd;

class Utf8Decoder {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!/^\s*(utf-?8|unicode-1-1-utf-8)\s*$/i.test(label)) throw new RangeError(`TextDecoder: only UTF-8 is supported, not ${label}`);
    this.fatal = options.fatal ?? false;
    this.ignoreBOM = options.ignoreBOM ?? false;
  }

  decode(input?: DecodeInput): string {
    if (!input) return "";
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let i = !this.ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const codes: number[] = [];
    let out = "";
    // WHATWG's UTF-8 decoder: a bad byte is one replacement character, and the byte after it starts afresh.
    let needed = 0;
    let seen = 0;
    let code = 0;
    let lower = 0x80;
    let upper = 0xbf;

    const bad = () => {
      if (this.fatal) throw new TypeError("TextDecoder: the data is not valid UTF-8");
      codes.push(REPLACEMENT);
    };

    for (; i <= bytes.length; i++) {
      if (i === bytes.length) {
        if (needed) bad();
        break;
      }

      const b = bytes[i]!;

      if (!needed) {
        if (b < 0x80) codes.push(b);
        else if (b >= 0xc2 && b <= 0xdf) [needed, code] = [1, b & 0x1f];
        else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          else if (b === 0xed) upper = 0x9f;
          [needed, code] = [2, b & 0xf];
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          else if (b === 0xf4) upper = 0x8f;
          [needed, code] = [3, b & 0x7];
        } else bad();
      } else if (b < lower || b > upper) {
        [needed, seen, code, lower, upper] = [0, 0, 0, 0x80, 0xbf];
        bad();
        // The byte that broke the sequence starts the next one.
        i--;
      } else {
        [lower, upper] = [0x80, 0xbf];
        code = (code << 6) | (b & 0x3f);

        if (++seen === needed) {
          if (code > 0xffff) {
            code -= 0x10000;
            codes.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
          } else codes.push(code);

          [needed, seen, code] = [0, 0, 0];
        }
      }

      // In slices, so a long input doesn't overflow fromCharCode's arguments.
      if (codes.length >= 8192) out += String.fromCharCode(...codes.splice(0));
    }

    return out + String.fromCharCode(...codes);
  }
}

if (!("TextDecoder" in globalThis)) Object.assign(globalThis, { TextDecoder: Utf8Decoder });

export {};
