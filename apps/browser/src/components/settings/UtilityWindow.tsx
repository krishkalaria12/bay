import { View } from "@bay/platform";
import { ImportWindow } from "../import/ImportWindow";
import { CaptionButtons } from "../layout/CaptionButtons";
import { TaskManagerWindow } from "../taskManager/TaskManagerWindow";
import { TASK_MANAGER_WINDOW_ID } from "../taskManager/window";
import { SettingsWindow } from "./SettingsWindow";
import { SETTINGS_WINDOW_ID } from "./windows";

// Windows' caption buttons, over the window's top corner.
const CAPTION_HEIGHT = 32;

export function UtilityWindow({ id }: { id: string }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <UtilityContent id={id} />
      </View>
      <CaptionButtons windowId={id} height={CAPTION_HEIGHT} />
    </View>
  );
}

function UtilityContent({ id }: { id: string }) {
  if (id === TASK_MANAGER_WINDOW_ID) return <TaskManagerWindow />;
  return id === SETTINGS_WINDOW_ID ? <SettingsWindow /> : <ImportWindow />;
}
