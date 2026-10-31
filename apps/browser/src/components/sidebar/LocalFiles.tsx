import {
  localFiles,
  LocalFilesArea,
  onWindowEvent,
  prompt,
  setSidebarKeyboard,
  showMenu,
  Symbol,
  type LocalFileAccess,
  type LocalFileEntry,
  type LocalFileListing,
} from "@bay/shell";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { closeLocalFileTab, localFileStatusText, openLocalFile, peekLocalFile, reconnectLocalFile } from "../../lib/localFiles";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { usePageSpaceId } from "../../store/hooks";
import { localFilePins } from "../../store/localFiles";
import { spaceFolded } from "../../store/model";
import type { LocalFilePin } from "../../store/types";
import { useSidebarMetrics } from "./tokens";
import { blurSidebar, registerSidebarKeyboardRows, type SidebarKeyboardRow } from "./keyboard";
import { SidebarKeyboardRowView } from "./keyboardFocus";

const fileRowId = (id: string, relativePath = "") => `file|${encodeURIComponent(id)}${relativePath ? `|${encodeURIComponent(relativePath)}` : ""}`;

// Async directory loads mount rows in a different order. Sort their tree positions before publishing visible rows.
function fileKeyboardRegistry(windowId: string, spaceId: string, enabled: boolean) {
  const rows = new Map<string, { row: SidebarKeyboardRow; position: number[] }>();
  let unregister: (() => void) | undefined;
  const publish = () => {
    const ordered = [...rows.values()].sort((a, b) => {
      for (let i = 0; i < Math.min(a.position.length, b.position.length); i++) {
        const delta = a.position[i]! - b.position[i]!;
        if (delta) return delta;
      }
      return a.position.length - b.position.length;
    });
    unregister = registerSidebarKeyboardRows(windowId, spaceId, "finderFiles", enabled ? ordered.map(({ row }) => row) : []);
  };
  return {
    set(row: SidebarKeyboardRow, position: number[]) {
      rows.set(row.id, { row, position });
      publish();
    },
    remove(id: string) {
      rows.delete(id);
      publish();
    },
    dispose() {
      unregister?.();
    },
  };
}
const FileKeyboardContext = createContext<ReturnType<typeof fileKeyboardRegistry> | null>(null);

/** Insert inside the pinned section, before tail:pinned. FinderDropZone wraps that section in dnd.tsx. */
export function LocalFiles({ windowId, spaceId: requestedSpace }: { windowId: string; spaceId?: string }) {
  const page = usePageSpaceId();
  const spaceId = requestedSpace ?? page;
  const privateWindow = useBrowser((s) => !!s.windows[windowId]?.incognito);
  const folded = useBrowser((s) => spaceFolded(s, spaceId));
  const pins = useBrowser(useShallow((s) => localFilePins(s, spaceId)));
  const registry = useMemo(() => fileKeyboardRegistry(windowId, spaceId, !folded && !privateWindow), [windowId, spaceId, folded, privateWindow]);
  useEffect(() => () => registry.dispose(), [registry]);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const sub = onWindowEvent((event) => {
      if (event.type === "focus" && event.id === windowId) refresh((value) => value + 1);
    });
    return () => sub.remove();
  }, [windowId]);
  if (privateWindow) return null;
  return (
    <FileKeyboardContext.Provider value={registry}>
      {pins.map((pin, index) => (
        <LocalFileBlock key={pin.id} pin={pin} windowId={windowId} revision={revision} position={[index]} />
      ))}
    </FileKeyboardContext.Provider>
  );
}

function LocalFileBlock({ pin, windowId, revision, position }: { pin: LocalFilePin; windowId: string; revision: number; position: number[] }) {
  const [access, setAccess] = useState<LocalFileAccess | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setAccess(null);
    setError("");
    void localFiles.inspect(pin.path).then(
      (result) => {
        if (alive) setAccess(result);
      },
      () => {
        if (alive) setAccess({ status: "inaccessible" });
      },
    );
    return () => {
      alive = false;
    };
  }, [pin.path, revision, retry]);
  const available = access?.status === "available";
  // A reconnect may point at another local URL. Always use the native kind when available.
  const folder = available ? access.kind === "folder" : pin.kind === "folder";
  const reconnect = async () => {
    try {
      if (await reconnectLocalFile(pin.id)) setRetry((v) => v + 1);
    } catch {
      setError("Couldn't grant access. Try again.");
    }
  };
  const open = async (relativePath = "") => {
    try {
      const result = await openLocalFile(windowId, pin.id, relativePath);
      if (result.status !== "available") setError(localFileStatusText(result));
      else {
        blurSidebar(windowId);
        void setSidebarKeyboard(windowId, false);
      }
    } catch {
      setError("Couldn't open this file. Try again.");
    }
  };
  const rename = async () => {
    const current = useBrowser.getState().localFiles[pin.id];
    if (!current) return;
    const name = await prompt({ title: "Rename Pin", value: current.name, confirmTitle: "Rename", windowId });
    if (name?.trim()) useBrowser.getState().renameLocalFile(pin.id, name);
  };
  const peek = (relativePath = "") => {
    void peekLocalFile(windowId, pin.id, relativePath).then(
      (result) => {
        if (result.status !== "available") setError(localFileStatusText(result));
        else {
          blurSidebar(windowId);
          void setSidebarKeyboard(windowId, false);
        }
      },
      () => setError("Couldn't preview this file. Try again."),
    );
  };
  const rowId = fileRowId(pin.id);
  const menu = async () => {
    const choice = await showMenu([
      { id: "open", title: folder ? "Open in Finder" : "Open", enabled: available },
      { id: "reconnect", title: "Locate on This Mac…" },
      { id: "refresh", title: "Refresh" },
      { separator: true },
      { id: "rename", title: "Rename Pin…" },
      { id: "up", title: "Move Up" },
      { id: "down", title: "Move Down" },
      { id: "remove", title: "Remove from Sidebar" },
    ]);
    const s = useBrowser.getState();
    if (!s.localFiles[pin.id]) return;
    if (choice === "remove") s.removeLocalFile(pin.id);
    else if (choice === "open") void open();
    else if (choice === "reconnect") void reconnect();
    else if (choice === "refresh") setRetry((v) => v + 1);
    else if (choice === "rename") void rename();
    else if (choice === "up" || choice === "down") {
      const pins = localFilePins(s, pin.spaceId);
      const index = pins.findIndex((p) => p.id === pin.id);
      if (choice === "up" && index > 0) s.moveLocalFile(pin.id, pins[index - 1]!.id);
      if (choice === "down" && index < pins.length - 1) s.moveLocalFile(pin.id, pins[index + 2]?.id ?? null);
    }
  };
  return (
    <View>
      <FileRow
        position={position}
        keyboardRow={{
          id: rowId,
          kind: "local",
          tabIds: [],
          collapsed: available && folder ? !pin.expanded : undefined,
          open: () => {
            if (!access || available) void open();
            else void reconnect();
          },
          peek: () => {
            if (!access || available) peek();
            else void reconnect();
          },
          close: () => useBrowser.getState().removeLocalFile(pin.id),
          rename: () => void rename(),
          expand: (collapsed) => useBrowser.getState().setLocalFileExpanded(pin.id, !collapsed),
        }}
        rootPath={pin.path}
        name={pin.name}
        folder={folder}
        expanded={pin.expanded}
        available={available}
        depth={0}
        onPress={() => {
          if (!access) return;
          if (!available) void reconnect();
          else if (folder) useBrowser.getState().setLocalFileExpanded(pin.id, !pin.expanded);
          else void open();
        }}
        onContextMenu={() => void menu()}
      />
      {!available ? <FileNote text={localFileStatusText(access)} action={access ? "Locate…" : undefined} onPress={() => void reconnect()} /> : null}
      {error ? (
        <FileNote
          text={error}
          action="Retry"
          onPress={() => {
            setError("");
            setRetry((v) => v + 1);
          }}
        />
      ) : null}
      {available && folder && pin.expanded ? (
        <FolderContents
          key={`${pin.path}:${revision}:${retry}`}
          pin={pin}
          windowId={windowId}
          relativePath=""
          depth={1}
          position={position}
          open={open}
          peek={peek}
        />
      ) : null}
    </View>
  );
}

type FolderProps = {
  pin: LocalFilePin;
  windowId: string;
  relativePath: string;
  depth: number;
  position: number[];
  open: (path: string) => Promise<void>;
  peek: (path: string) => void;
};

function FolderContents({ pin, windowId, relativePath, depth, position, open, peek }: FolderProps) {
  const [listing, setListing] = useState<LocalFileListing | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setListing(null);
    void localFiles.list(pin.path, relativePath).then(
      (result) => {
        if (alive) setListing(result);
      },
      () => {
        if (alive) setListing({ access: { status: "inaccessible" }, entries: [] });
      },
    );
    return () => {
      alive = false;
    };
  }, [pin.path, relativePath, retry]);
  if (!listing) return <FileNote text="Loading…" />;
  if (listing.access.status !== "available")
    return <FileNote text={localFileStatusText(listing.access)} action="Retry" onPress={() => setRetry((v) => v + 1)} />;
  if (!listing.entries.length) return <FileNote text="Empty folder" />;
  return (
    <>
      {listing.entries.map((entry, index) => (
        <FileChild key={entry.relativePath} pin={pin} windowId={windowId} entry={entry} depth={depth} position={[...position, index]} open={open} peek={peek} />
      ))}
    </>
  );
}

function FileChild({ pin, windowId, entry, depth, position, open, peek }: Omit<FolderProps, "relativePath"> & { entry: LocalFileEntry }) {
  const [expanded, setExpanded] = useState(false);
  const folder = entry.kind === "folder";
  const parent = entry.relativePath.includes("/") ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/")) : "";
  return (
    <>
      <FileRow
        position={position}
        keyboardRow={{
          id: fileRowId(pin.id, entry.relativePath),
          parentId: fileRowId(pin.id, parent),
          kind: "local",
          tabIds: [],
          collapsed: folder ? !expanded : undefined,
          open: () => void open(entry.relativePath),
          peek: () => peek(entry.relativePath),
          close: () => {
            void closeLocalFileTab(windowId, pin.id, entry.relativePath).catch(() => {});
          },
          expand: (collapsed) => setExpanded(!collapsed),
        }}
        rootPath={pin.path}
        relativePath={entry.relativePath}
        name={entry.name}
        folder={folder}
        expanded={expanded}
        available
        depth={depth}
        onPress={() => {
          if (folder) setExpanded((v) => !v);
          else void open(entry.relativePath);
        }}
      />
      {folder && expanded ? (
        <FolderContents pin={pin} windowId={windowId} relativePath={entry.relativePath} depth={depth + 1} position={position} open={open} peek={peek} />
      ) : null}
    </>
  );
}

function FileRow({
  rootPath,
  relativePath = "",
  name,
  folder,
  expanded,
  available,
  depth,
  onPress,
  onContextMenu,
  keyboardRow,
  position,
}: {
  keyboardRow: SidebarKeyboardRow;
  position: number[];
  rootPath: string;
  relativePath?: string;
  name: string;
  folder: boolean;
  expanded: boolean;
  available: boolean;
  depth: number;
  onPress: () => void;
  onContextMenu?: () => void;
}) {
  const registry = useContext(FileKeyboardContext);
  useLayoutEffect(() => {
    registry?.set(keyboardRow, position);
  });
  useLayoutEffect(() => () => registry?.remove(keyboardRow.id), [registry, keyboardRow.id]);
  const theme = useTheme();
  const metrics = useSidebarMetrics();
  return (
    <SidebarKeyboardRowView
      rowId={keyboardRow.id}
      label={`${name}${folder ? ", folder" : ""}${available ? "" : ", unavailable on this Mac"}`}
      accessibilityState={folder ? { expanded } : undefined}
      onAccessibilityTap={onPress}
    >
      <LocalFilesArea
        rootPath={rootPath}
        relativePath={relativePath}
        onActivate={onPress}
        onContextMenu={onContextMenu}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${name}${folder ? ", folder" : ""}${available ? "" : ", unavailable on this Mac"}`}
        accessibilityState={folder ? { expanded } : undefined}
        tooltip={rootPath + (relativePath ? `/${relativePath}` : "")}
        style={{
          minHeight: metrics.rowHeight,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 9 + Math.min(depth, 10) * 14,
          paddingRight: 8,
          borderRadius: 8,
          opacity: available ? 1 : 0.55,
        }}
      >
        <Symbol name={folder ? (expanded ? "folder.fill" : "folder") : "doc"} size={15} color={theme.icon} style={{ width: 18, height: 18 }} />
        <Text numberOfLines={1} style={{ color: theme.textTab, fontSize: 13, flex: 1, marginLeft: 7 }}>
          {name}
        </Text>
        {folder ? <Symbol name={expanded ? "chevron.down" : "chevron.right"} size={9} color={theme.textSecondary} style={{ width: 14, height: 14 }} /> : null}
      </LocalFilesArea>
    </SidebarKeyboardRowView>
  );
}

function FileNote({ text, action, onPress }: { text: string; action?: string; onPress?: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 34, paddingRight: 8, paddingVertical: 4, gap: 5 }}>
      <Text style={{ color: theme.textSecondary, fontSize: 11, flex: 1 }}>{text}</Text>
      {action ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={action}>
          <Text style={{ color: theme.textTab, fontSize: 11 }}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
