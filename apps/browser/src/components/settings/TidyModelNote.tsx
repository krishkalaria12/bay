import { tidyTabsModel, type TidyModelStatus } from "@bay/desktop";
import { useEffect, useState } from "react";
import { Linking, Text } from "react-native";
import { useTheme } from "../../lib/theme";

// System Settings › Apple Intelligence & Siri.
const APPLE_INTELLIGENCE_SETTINGS = "x-apple.systempreferences:com.apple.Siri-Settings.extension";

const WHY: Partial<Record<TidyModelStatus, string>> = {
  off: "Turn on Apple Intelligence for better results.",
  preparing: "Apple Intelligence is still downloading; results improve once it's ready.",
  ineligible: "Better results need Apple Intelligence, which this Mac doesn't support.",
  needsNewerMacOS: "Better results need Apple Intelligence, which needs macOS 26 or later.",
  unavailable: "Apple Intelligence isn't available right now.",
};

const readStatus = (): TidyModelStatus | null => tidyTabsModel?.modelStatus() ?? null;

/** What runs the Tidy features: read again while it shows, so turning Apple Intelligence on needs no relaunch. */
export function TidyModelNote({ available, fallback }: { available: string; fallback: string }) {
  const theme = useTheme();
  const [status, setStatus] = useState(readStatus);
  useEffect(() => {
    const timer = setInterval(() => setStatus(readStatus()), 3000);

    return () => clearInterval(timer);
  }, []);

  if (status === "available") return available;
  const why = status && WHY[status];

  if (!why) return fallback;

  return (
    <>
      {fallback} {why}
      {status === "off" || status === "preparing" ? (
        <Text style={{ color: theme.accent }} onPress={() => void Linking.openURL(APPLE_INTELLIGENCE_SETTINGS)}>
          {" Open System Settings"}
        </Text>
      ) : null}
    </>
  );
}
