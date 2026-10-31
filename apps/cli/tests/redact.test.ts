import { expect, it } from "bun:test";
import { RedactingStream, addSecret } from "../src/redact.ts";

it("redacts secrets split across writes", () => {
  addSecret("test-secret-1234");
  let text = "";
  const stream = new RedactingStream((chunk) => {
    text += chunk;
  });
  stream.push("hello test-sec");
  stream.push("ret-1234 world");
  stream.drain();
  expect(text).toBe("hello *** world");
});

it("redacts byte writes and preserves UTF-8 split across chunks", () => {
  const module = new URL("../src/redact.ts", import.meta.url).href;
  const code = `import {addSecret,installOutputRedaction,drainOutput} from ${JSON.stringify(module)};
    addSecret('buffer-secret-1234'); installOutputRedaction();
    process.stdout.write(Buffer.from('buffer-sec'));
    process.stdout.write(Buffer.from('ret-1234'));
    const bytes=Buffer.from(' café'); process.stdout.write(bytes.subarray(0,5)); process.stdout.write(bytes.subarray(5));
    await new Promise(resolve=>process.stderr.write('done',resolve)); drainOutput();`;
  const child = Bun.spawnSync([process.execPath, "-e", code]);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("*** café");
  expect(child.stderr.toString()).toBe("done");
});
