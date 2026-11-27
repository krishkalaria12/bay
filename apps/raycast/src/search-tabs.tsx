import { Action, ActionPanel, Icon, List, closeMainWindow, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { focusTab, listTabs } from "./bay";
import { hostOf, type BayTab } from "./parse";

// Every open tab in every space (private windows aside), grouped by space; Enter shows it.
export default function SearchTabs() {
  const { data = [], isLoading, error } = usePromise(listTabs);
  const spaces = [...new Set(data.map((t) => t.space))];

  const show = async (tab: BayTab) => {
    try {
      await focusTab(tab);
      await closeMainWindow();
    } catch (failure) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't show the tab", message: String(failure) });
    }
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search tabs by title or address">
      {error ? <List.EmptyView icon={Icon.Warning} title="Couldn't reach Bay" description={error.message} /> : null}
      {!isLoading && !error && !data.length ? <List.EmptyView title="No tabs" description="Bay isn't running, or has no tabs open." /> : null}
      {spaces.map((space) => (
        <List.Section key={space || "none"} title={space || "Bay"}>
          {data
            .filter((t) => t.space === space)
            .map((t) => (
              <List.Item
                key={`${t.windowId}:${t.id}`}
                icon={Icon.Globe}
                title={t.title || t.url || "New Tab"}
                subtitle={hostOf(t.url)}
                keywords={[t.url]}
                accessories={[...(t.pinned ? [{ icon: Icon.Pin, tooltip: "Pinned" }] : []), ...(t.focused ? [{ tag: "Shown" }] : [])]}
                actions={
                  <ActionPanel>
                    <Action title="Show Tab" icon={Icon.Eye} onAction={() => void show(t)} />
                    {t.url ? <Action.CopyToClipboard title="Copy Address" content={t.url} /> : null}
                  </ActionPanel>
                }
              />
            ))}
        </List.Section>
      ))}
    </List>
  );
}
