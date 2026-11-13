// The app's local files: where a Space's files live, and what this Mac may read of them.
//
// The work is in lib/localFileService.ts. This is where the app reaches it.
import type { LocalFileAccess } from "@bay/desktop";
import * as Effect from "effect/Effect";
import { runDesktop } from "../effect/runtime";
import { LocalFileService } from "./localFileService";
import { hasServiceClient, requestService } from "../runtime/serviceClient";
import { platformWords } from "./platformWords";

/** Resolves native access before opening anything. Synced paths alone never authorize a file. */
export function openLocalFile(windowId: string, pinId: string, relativePath = ""): Promise<LocalFileAccess> {
  if (hasServiceClient()) return requestService("localFileOpen", [windowId, pinId, relativePath]);

  return runDesktop(
    Effect.gen(function* () {
      const files = yield* LocalFileService;

      return yield* files.open(windowId, pinId, relativePath);
    }),
  );
}

/** Space peeks browser-readable files; other formats keep their native app's preview/open behavior. */
export function peekLocalFile(windowId: string, pinId: string, relativePath = ""): Promise<LocalFileAccess> {
  if (hasServiceClient()) return requestService("localFilePeek", [windowId, pinId, relativePath]);

  return runDesktop(
    Effect.gen(function* () {
      const files = yield* LocalFileService;

      return yield* files.peek(windowId, pinId, relativePath);
    }),
  );
}

/** Native saves an alias under the original synced path. Reconnection is local to this Mac. */
export function reconnectLocalFile(pinId: string): Promise<boolean> {
  if (hasServiceClient()) return requestService("localFileReconnect", [pinId]);

  return runDesktop(
    Effect.gen(function* () {
      const files = yield* LocalFileService;

      return yield* files.reconnect(pinId);
    }),
  );
}

/** Descendant rows close their opened page. They never delete or move a filesystem entry. */
export function closeLocalFileTab(windowId: string, pinId: string, relativePath: string): Promise<void> {
  if (hasServiceClient()) return requestService("localFileClose", [windowId, pinId, relativePath]).then(() => {});

  return runDesktop(
    Effect.gen(function* () {
      const files = yield* LocalFileService;

      yield* files.close(windowId, pinId, relativePath);
    }),
  );
}

/** What the app tells the user about a file it may not read. */
export function localFileStatusText(access: LocalFileAccess | null): string {
  if (!access) return "Checking access…";

  return access.status === "missing"
    ? `Missing on ${platformWords.thisComputer}`
    : access.status === "inaccessible"
      ? `Access required on ${platformWords.thisComputer}`
      : "";
}
