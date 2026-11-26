import { Action, ActionPanel, Icon, List, closeMainWindow, open, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { NoBayCommand, newTab, searchHistory } from "./bay";
import { hostOf, type Visit } from "./parse";

// The last month's pages from Bay's history, through the bay command (which needs Settings › Advanced › Let the bay
// command control Bay). Enter opens one in a new tab.
export default function SearchHistory() {
  const { data = [], isLoading, error } = usePromise(() => searchHistory());

  const openVisit = async (visit: Visit) => {
    try {
      await closeMainWindow();
      await newTab(visit.url);
    } catch (failure) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't open the page", message: String(failure) });
    }
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search history by title or address">
      {error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title={error instanceof NoBayCommand ? "The bay command isn't installed" : "Couldn't read Bay's history"}
          description={error.message}
          actions={
            <ActionPanel>
              <Action title="Open Bay" icon={Icon.AppWindow} onAction={() => void open("bay://settings")} />
            </ActionPanel>
          }
        />
      ) : null}
      {data.map((v) => (
        <List.Item
          key={`${v.space}:${v.url}`}
          icon={Icon.Globe}
          title={v.title}
          subtitle={hostOf(v.url)}
          keywords={[v.url]}
          accessories={[...(v.space ? [{ tag: v.space }] : []), ...(v.lastVisit ? [{ date: new Date(v.lastVisit) }] : [])]}
          actions={
            <ActionPanel>
              <Action title="Open in Bay" icon={Icon.Globe} onAction={() => void openVisit(v)} />
              <Action.CopyToClipboard title="Copy Address" content={v.url} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
