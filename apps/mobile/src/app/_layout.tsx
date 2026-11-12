import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { useEffect, type JSX } from "react";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useAppFonts } from "@/chrome/fonts";
import { loadLocale, refreshDeviceLocale } from "@/i18n";

import "../global.css";

// The saved language is read before the first screen draws, alongside the browsing state, so the app opens in it.
void loadLocale();

export default function RootLayout(): JSX.Element | null {
  const fontsReady = useAppFonts();

  // A language changed in the phone's settings while Bay was away shows on return, unless one was picked in Bay.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshDeviceLocale();
    });

    return () => subscription.remove();
  }, []);

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
