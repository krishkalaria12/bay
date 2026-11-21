import { View } from "@bay/platform";
import { StyleSheet } from "react-native";
import { useBrowserRead as useBrowser } from "../../store/read";
import { useWindowId } from "../../store/hooks";
import { tourAnchorRef } from "../onboarding/tour/anchors";
import { CheckInBanner } from "./DefaultBrowserBanner";
import { PersonalizeButton } from "./PersonalizePanel";
import { ReleaseNotesPage, ReleaseNotesPostcard } from "./ReleaseNotesCard";
import { TelemetryAsk } from "./TelemetryBanner";
import { closeReleaseNotes, openReleaseNotes, retireReleaseNotes, usePendingReleaseNotes, useReleaseNotesPage } from "./releaseNotes";

export function NewTabExtras({ size }: { size: { width: number; height: number } }) {
  const windowId = useWindowId();
  const incognito = useBrowser((s) => !!s.windows[windowId]?.incognito);
  const pending = usePendingReleaseNotes();
  const page = useReleaseNotesPage(windowId);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View ref={tourAnchorRef(windowId, "page")} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <CheckInBanner windowId={windowId} />
      <TelemetryAsk windowId={windowId} />
      {incognito ? null : <PersonalizeButton windowId={windowId} />}
      {pending && !incognito && !page ? (
        <ReleaseNotesPostcard notes={pending} size={size} onOpen={() => openReleaseNotes(windowId)} onDismiss={retireReleaseNotes} />
      ) : null}
      {page ? <ReleaseNotesPage notes={page} size={size} onClose={closeReleaseNotes} /> : null}
    </View>
  );
}
