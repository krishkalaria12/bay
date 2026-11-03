import { WindowProfile as NativeWindowProfile } from "@bay/desktop";
import { useShallow } from "zustand/react/shallow";
import { useQuietBrowser, useWindowId } from "../../store/hooks";
import { engineProfileFor } from "../../store/model";

export function WindowProfile() {
  const windowId = useWindowId();
  const [profile, neighbours] = useQuietBrowser(
    useShallow((s) => {
      const w = s.windows[windowId];
      if (!w) return ["", "[]"];
      const at = w.incognito ? -1 : s.spaceOrder.indexOf(w.spaceId);
      const next = at < 0 ? [] : [s.spaceOrder[at - 1], s.spaceOrder[at + 1]].filter((p): p is string => !!p).map((id) => engineProfileFor(id, s.spaces));
      return [engineProfileFor(w.spaceId, s.spaces), JSON.stringify(next)];
    }),
  );
  return <NativeWindowProfile profile={profile} neighbours={JSON.parse(neighbours) as string[]} style={{ position: "absolute", width: 0, height: 0 }} />;
}
