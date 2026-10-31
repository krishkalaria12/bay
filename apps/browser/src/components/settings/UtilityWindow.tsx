import { View } from "@bay/platform";
import { ImportWindow } from "../import/ImportWindow";
import { CaptionButtons } from "../layout/CaptionButtons";
import { TaskManagerWindow } from "../taskManager/TaskManagerWindow";
import { TASK_MANAGER_WINDOW_ID } from "../taskManager/window";
import { SettingsWindow } from "./SettingsWindow";
import { SETTINGS_WINDOW_ID } from "./windows";

// Windows' standard caption height: these windows' own bars are taller, so the buttons sit at their top.
const CAPTION_HEIGHT = 32;

export function UtilityWindow({ id }: { id: string }) {
  return (
    <View style={{ flex: 1 }}>
      <UtilityContent id={id} />
      <CaptionButtons windowId={id} height={CAPTION_HEIGHT} />
    </View>
  );
}

function UtilityContent({ id }: { id: string }) {
  if (id === TASK_MANAGER_WINDOW_ID) return <TaskManagerWindow />;
  return id === SETTINGS_WINDOW_ID ? <SettingsWindow /> : <ImportWindow />;
}
