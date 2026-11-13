// The app's files: the documents it keeps and the cache it works in. A path is a root and a relative path, so a
// service never holds a file:// URI it cannot rebuild. The native module is loaded inside the calls, so this file
// stays importable where Expo is not.
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Operation } from "../errors.ts";

/** Where a file lives: the documents the system keeps, or the cache it may clear. */
export type FileRoot = "document" | "cache";

/** The digests a file's contents can be read with. */
export type FileDigest = "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

/** A file that could not be read, written, moved or listed. */
export class FileError extends TaggedError("FileError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The native module, loaded when a file is first needed. */
const fileSystem = () => import("expo-file-system");

/** Runs one file operation, naming it when it fails. */
const withFiles = <A>(operation: Operation, use: (files: typeof import("expo-file-system")) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => use(await fileSystem()),
    catch: (cause) => new FileError({ operation, cause }),
  });

export class Files extends Context.Service<
  Files,
  {
    /** Reads a file. It is null when there isn't one. */
    readonly read: (root: FileRoot, path: string) => Effect.Effect<string | null, FileError>;
    /** Writes a file now. It has landed when this returns. */
    readonly write: (root: FileRoot, path: string, contents: string) => Effect.Effect<void, FileError>;
    /** Whether a file is there. */
    readonly exists: (root: FileRoot, path: string) => Effect.Effect<boolean, FileError>;
    /** Forgets a file. Forgetting one that isn't there is not a failure. */
    readonly delete: (root: FileRoot, path: string) => Effect.Effect<void, FileError>;
    /** Moves a file, replacing the one that is in the way. */
    readonly move: (root: FileRoot, from: string, to: string) => Effect.Effect<void, FileError>;
    /** How many bytes a file holds. */
    readonly size: (root: FileRoot, path: string) => Effect.Effect<number, FileError>;
    /** The digest of a file's contents. */
    readonly digest: (root: FileRoot, path: string, algorithm: FileDigest) => Effect.Effect<string, FileError>;
    /** Downloads a file into a root. */
    readonly download: (root: FileRoot, path: string, url: string, headers?: Readonly<Record<string, string>>) => Effect.Effect<void, FileError>;
    /** The names of the files in a directory. */
    readonly list: (root: FileRoot, path: string) => Effect.Effect<readonly string[], FileError>;
    /** Makes a directory, and the ones above it. */
    readonly createDirectory: (root: FileRoot, path: string) => Effect.Effect<void, FileError>;
  }
>()("bay/Files") {
  static readonly layer = Layer.succeed(Files)({
    read: (root, path) =>
      withFiles({ name: "files.read", resource: path }, async ({ File, Paths }) => {
        const file = new File(Paths[root], path);

        return file.exists ? await file.text() : null;
      }),
    write: (root, path, contents) =>
      withFiles({ name: "files.write", resource: path }, async ({ File, Paths }) => {
        await new File(Paths[root], path).write(contents);
      }),
    exists: (root, path) => withFiles({ name: "files.exists", resource: path }, async ({ File, Paths }) => new File(Paths[root], path).exists),
    delete: (root, path) =>
      withFiles({ name: "files.delete", resource: path }, async ({ File, Paths }) => {
        const file = new File(Paths[root], path);

        if (file.exists) file.delete();
      }),
    move: (root, from, to) =>
      withFiles({ name: "files.move", resource: from }, async ({ File, Paths }) => {
        await new File(Paths[root], from).move(new File(Paths[root], to), { overwrite: true });
      }),
    size: (root, path) => withFiles({ name: "files.size", resource: path }, async ({ File, Paths }) => new File(Paths[root], path).size),
    digest: (root, path, algorithm) =>
      withFiles({ name: "files.digest", resource: path }, async ({ File, Paths }) => await new File(Paths[root], path).digest(algorithm)),
    download: (root, path, url, headers) =>
      withFiles({ name: "files.download", resource: path }, async ({ File, Paths }) => {
        await File.downloadFileAsync(url, new File(Paths[root], path), { headers: headers ? { ...headers } : undefined, idempotent: true });
      }),
    list: (root, path) =>
      withFiles({ name: "files.list", resource: path }, async ({ Directory, Paths }) => new Directory(Paths[root], path).list().map((entry) => entry.name)),
    createDirectory: (root, path) =>
      withFiles({ name: "files.createDirectory", resource: path }, async ({ Directory, Paths }) => {
        new Directory(Paths[root], path).create({ intermediates: true, idempotent: true });
      }),
  });
}
