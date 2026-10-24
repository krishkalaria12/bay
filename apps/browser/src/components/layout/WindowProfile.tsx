import { WindowProfile as NativeWindowProfile } from "@bay/shell";
import { useShallow } from "zustand/react/shallow";
import { useBrowserRead as useBrowser } from "../../store/read";
import { useWindowId } from "../../store/hooks";
import { engineProfile } from "../../store/model";

export function WindowProfile() {
  const windowId = useWindowId();
  const [profile, neighbours] = useBrowser(
    useShallow((s) => {
      const w = s.windows[windowId];
      if (!w) return ["", "[]"];
      const at = w.incognito ? -1 : s.spaceOrder.indexOf(w.spaceId);
      const next = at < 0 ? [] : [s.spaceOrder[at - 1], s.spaceOrder[at + 1]].filter((p): p is string => !!p).map(engineProfile);
      return [engineProfile(w.spaceId), JSON.stringify(next)];
    }),
  );
  return <NativeWindowProfile profile={profile} neighbours={JSON.parse(neighbours) as string[]} style={{ position: "absolute", width: 0, height: 0 }} />;
}
