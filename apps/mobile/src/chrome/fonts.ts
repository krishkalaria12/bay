import { useFonts } from "expo-font";
import { Platform } from "react-native";

import { androidFaces } from "./tokens";

// Only the four weights the type scale uses: the package's index would bundle all eighteen faces.
const faces = {
  [androidFaces.regular]: require("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
  [androidFaces.medium]: require("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf"),
  [androidFaces.semibold]: require("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
  [androidFaces.bold]: require("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
};

/**
 * Whether Bay's fonts are ready. Android loads Inter before the first screen draws, so text never jumps from Roboto to
 * Inter; iOS uses San Francisco and has nothing to load. A face that fails to load leaves Android on Roboto rather than
 * on a blank screen.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(Platform.OS === "android" ? faces : {});

  return Platform.OS !== "android" || loaded || error !== null;
}
