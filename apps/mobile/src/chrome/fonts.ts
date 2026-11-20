import { useFonts } from "expo-font";
import { Platform } from "react-native";

import { androidFaces } from "./tokens";

// Only the faces Bay draws: the package's index would bundle all eighteen.
const faces = {
  [androidFaces.regular]: require("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
  [androidFaces.medium]: require("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf"),
  [androidFaces.semibold]: require("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
  [androidFaces.bold]: require("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
  // The welcome's name, drawn in Bay's heaviest letters (src/onboarding/Controls.android.tsx).
  Inter_900Black: require("@expo-google-fonts/inter/900Black/Inter_900Black.ttf"),
};

/**
 * The pen's hand: the welcome's notes, as on Bay's site (apps/web, Caveat 600). Both platforms load it; text in it waits
 * on nothing and simply draws once it's in.
 */
export const PEN_FACE = "Caveat_600SemiBold";
const pen = { [PEN_FACE]: require("@expo-google-fonts/caveat/600SemiBold/Caveat_600SemiBold.ttf") };

/**
 * Whether Bay's fonts are ready. Android loads Inter before the first screen draws, so text never jumps from Roboto to
 * Inter; iOS uses San Francisco and has nothing to load. A face that fails to load leaves Android on Roboto rather than
 * on a blank screen.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(Platform.OS === "android" ? { ...faces, ...pen } : pen);

  return Platform.OS !== "android" || loaded || error !== null;
}
