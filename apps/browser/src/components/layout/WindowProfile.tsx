import { WindowProfile as NativeWindowProfile } from "@bay/shell";
import { useStore } from "zustand";
import { DEFAULT_SPACE_ID } from "../../store/constants";
import { useWindowField } from "../../store/hooks";
import { engineIdOf } from "../../store/spaces";
import { spaceOrderStore, spacesStore } from "../../store/views";

export function WindowProfile() {
  // The window's space, the spaces and their order, each followed on its own: a page's progress or title runs none.
  const spaceId = useWindowField((w) => w.spaceId, "");
  const incognito = useWindowField((w) => !!w.incognito, false);
  const order = useStore(spaceOrderStore);
  const spaces = useStore(spacesStore);
  // engineProfile's, from the spaces themselves.
  const profileOf = (id: string) => {
    if (spaces[id]) return engineIdOf(spaces[id]);
    return id === DEFAULT_SPACE_ID ? "" : id;
  };
  const at = !spaceId || incognito ? -1 : order.indexOf(spaceId);
  const neighbours = at < 0 ? [] : [order[at - 1], order[at + 1]].filter((p): p is string => !!p).map(profileOf);
  return <NativeWindowProfile profile={spaceId ? profileOf(spaceId) : ""} neighbours={neighbours} style={{ position: "absolute", width: 0, height: 0 }} />;
}
