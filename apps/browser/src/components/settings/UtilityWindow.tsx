import { WindowDragRegion } from "@bay/shell";
import { useWindowButtonLayout, utilityCaptionHeight } from "../layout/windowButtons";
import { View } from "@bay/platform";
import { ImportWindow } from "../import/ImportWindow";
import { CaptionButtons } from "../layout/CaptionButtons";
import { TaskManagerWindow } from "../taskManager/TaskManagerWindow";
import { TASK_MANAGER_WINDOW_ID } from "../taskManager/window";
import { SettingsWindow } from "./SettingsWindow";
import { SETTINGS_WINDOW_ID } from "./windows";

// A separate caption band keeps each utility window's own header clear of either group.
const CAPTION_HEIGHT = 32;

export function UtilityWindow({ id }: { id: string }) {
  const captionHeight = utilityCaptionHeight(useWindowButtonLayout(), CAPTION_HEIGHT);
  return (
    <View style={{ flex: 1 }}>
      {captionHeight ? <WindowDragRegion style={{ height: captionHeight }} /> : null}
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
