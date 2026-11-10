import * as v from "valibot";
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { fstatSync, lstatSync } from "node:fs";

/** A bearer token may only come from a plain file owned by the current user. */
export function checkControlFile(path: string, fd: number): void {
  const opened = fstatSync(fd);
  const named = lstatSync(path);

  if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.ino !== named.ino || opened.dev !== named.dev) {
    throw new Error("isn't the same regular file that was opened");
  }

  if (process.platform === "win32") {
    checkWindowsAcl(path);
    const after = lstatSync(path);

    if (!after.isFile() || after.ino !== opened.ino || after.dev !== opened.dev) throw new Error("changed while checking its DACL");

    return;
  }

  if (v.is(v.function_(), process.getuid) && opened.uid !== process.getuid()) throw new Error("belongs to another user");

  if ((opened.mode & 0o777) !== 0o600) throw new Error("must be mode 0600");
}

function checkWindowsAcl(path: string): void {
  // Check the ACL itself rather than POSIX mode bits, which Windows emulates
  // as 0666 even for a file with a private DACL. Refuse every grant except the
  // current user. The browser publishes precisely that protected DACL.
  const api = dlopen("advapi32.dll", {
    GetNamedSecurityInfoW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
    OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    EqualSid: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetAce: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });

  const kernel = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
  });

  const tokenBuffer = Buffer.alloc(8);
  const descriptorBuffer = Buffer.alloc(8);
  const ownerBuffer = Buffer.alloc(8);
  const daclBuffer = Buffer.alloc(8);
  let token: Pointer | null = null;
  let descriptor: Pointer | null = null;
  const processHandle = kernel.symbols.OpenProcess(0x1000, 0, process.pid);

  try {
    if (!processHandle || !api.symbols.OpenProcessToken(processHandle, 0x8, tokenBuffer)) throw new Error("couldn't read the current user's token");
    token = pointer(tokenBuffer);
    const bytes = Buffer.alloc(4);
    api.symbols.GetTokenInformation(token, 1, null, 0, bytes);
    const size = bytes.readUInt32LE();

    if (!size || size > 64 * 1024) throw new Error("couldn't read the current user's SID");
    const user = Buffer.alloc(size);

    if (!api.symbols.GetTokenInformation(token, 1, user, size, bytes)) throw new Error("couldn't read the current user's SID");
    const sid = pointer(user);
    const name = Buffer.from(`${path}\0`, "utf16le");
    const status = api.symbols.GetNamedSecurityInfoW(name, 1, 0x1 | 0x4, ownerBuffer, null, daclBuffer, null, descriptorBuffer);
    descriptor = pointer(descriptorBuffer);
    const owner = pointer(ownerBuffer);
    const dacl = pointer(daclBuffer);

    if (status || !owner || !dacl || !sid || !api.symbols.EqualSid(owner, sid)) throw new Error("doesn't have a private owner and DACL");
    const count = read.u16(dacl, 4);

    if (!count || count > 1024) throw new Error("doesn't have a private DACL");

    for (let index = 0; index < count; index++) {
      const aceBuffer = Buffer.alloc(8);

      if (!api.symbols.GetAce(dacl, index, aceBuffer)) throw new Error("couldn't read its DACL");
      const ace = pointer(aceBuffer);

      if (!ace || read.u16(ace, 2) < 12) throw new Error("has an invalid DACL entry");
      // ACCESS_DENIED_ACE grants nothing; every allowed ACE must name this user.
      const type = read.u8(ace);

      if (type === 1) continue;

      // SAFETY: the checks above established this shape.
      if (type !== 0 || !api.symbols.EqualSid((Number(ace) + 8) as Pointer, sid)) throw new Error("grants access to another principal");
    }
  } finally {
    if (descriptor) kernel.symbols.LocalFree(descriptor);

    if (token) kernel.symbols.CloseHandle(token);

    if (processHandle) kernel.symbols.CloseHandle(processHandle);
    api.close();
    kernel.close();
  }
}

function pointer(buffer: Buffer): Pointer | null {
  // SAFETY: the checks above established this shape.
  return (Number(buffer.readBigUInt64LE(0)) || null) as Pointer | null;
}
