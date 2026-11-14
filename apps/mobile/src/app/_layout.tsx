import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { type JSX } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useAppFonts } from "@/chrome/fonts";
import { installCrashReports } from "@/crashReports";
import { runMobile, startAppServices } from "@/effect/runtime";
import { selfCheck } from "@/effect/selfCheck";

import "../global.css";

// A crash in a release build says nothing, so Bay keeps what happened (B8). The watch goes on first, so nothing that
// goes wrong on the way to the first screen is lost.
installCrashReports();

// The saved browsing state and language are read before the first screen draws, so the app opens on them. The splash
// stays up until the store says it is ready. A development build then checks once that Effect behaves under Hermes as
// it does in the tests; what it finds lands under Report a problem.
void startAppServices().then(() => (__DEV__ ? runMobile(selfCheck) : undefined));

export default function RootLayout(): JSX.Element | null {
  const fontsReady = useAppFonts();

  // The splash screen stays up until then.
  if (!fontsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
