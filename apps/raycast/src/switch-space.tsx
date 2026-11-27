import { Action, ActionPanel, Icon, List, closeMainWindow, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { focusSpace, listSpaces } from "./bay";
import type { BaySpace } from "./parse";

// Bay's spaces, in its order; Enter shows one in the front window.
export default function SwitchSpace() {
  const { data = [], isLoading, error } = usePromise(listSpaces);

  const show = async (space: BaySpace) => {
    try {
      await focusSpace(space);
      await closeMainWindow();
    } catch (failure) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't switch space", message: String(failure) });
    }
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search spaces">
      {error ? <List.EmptyView icon={Icon.Warning} title="Couldn't reach Bay" description={error.message} /> : null}
      {data.map((s) => (
        <List.Item
          key={s.id}
          icon={Icon.AppWindowSidebarLeft}
          title={s.name}
          accessories={s.shown ? [{ tag: "Shown" }] : []}
          actions={
            <ActionPanel>
              <Action title="Show Space" icon={Icon.Eye} onAction={() => void show(s)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
