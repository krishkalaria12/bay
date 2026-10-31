import { EngineView, type NavigationState, type Tab } from "@bay/engine";
import { Typography, useThemeColor } from "heroui-native";
import { useCallback, useRef, useState, type ComponentRef, type JSX } from "react";
import { BackHandler, Keyboard, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NavigationToolbar } from "@/chrome/NavigationToolbar";
import { StartToolbar } from "@/chrome/StartToolbar";
import { addressToURL } from "./address";

const initialNavigation: NavigationState = {
  url: "",
  title: "",
  progress: 0,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

export function BrowserScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const tab = useRef<Tab>(null);
  const addressInput = useRef<ComponentRef<typeof TextInput>>(null);
  const [navigation, setNavigation] = useState(initialNavigation);
  const [hasPage, setHasPage] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback((command: (current: Tab) => Promise<void>): void => {
    if (!tab.current) return;
    setError(null);
    void command(tab.current).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Couldn't open this page."));
  }, []);

  function openAddress(): void {
    try {
      const url = addressToURL(address);
      setHasPage(true);
      setEditing(false);
      Keyboard.dismiss();
      run((current) => current.load(url));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a website address.");
    }
  }

  function editAddress(): void {
    setAddress(navigation.url);
    setEditing(true);
  }

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (editing) {
          setEditing(false);
          return true;
        }
        if (navigation.canGoBack) {
          run((current) => current.goBack());
          return true;
        }
        return false;
      });
      return () => subscription.remove();
    }, [editing, navigation.canGoBack, run]),
  );

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ paddingTop: insets.top }}>
      <View className="flex-1">
        <EngineView
          ref={tab}
          style={{ flex: 1 }}
          onNavigationStateChange={({ nativeEvent }) => setNavigation(nativeEvent)}
          onNavigationError={({ nativeEvent }) => setError(nativeEvent.message)}
        />
        {!hasPage ? (
          <View className="absolute inset-0 items-center justify-end bg-background pb-6" testID="start-screen">
            <Typography.Paragraph className="text-muted">Tap to search</Typography.Paragraph>
          </View>
        ) : null}
      </View>

      <View className="gap-3 px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        {hasPage ? (
          <View>
            <Typography testID="page-title" numberOfLines={1}>
              {navigation.title || "Loading page"}
            </Typography>
            <Typography testID="page-url" className="text-muted" numberOfLines={1}>
              {navigation.url}
            </Typography>
            <Typography testID="page-status" className="text-muted">
              {navigation.isLoading ? `Loading ${Math.round(navigation.progress * 100)}%` : "Ready"}
            </Typography>
          </View>
        ) : null}
        {error ? (
          <Typography.Paragraph testID="navigation-error" accessibilityRole="alert">
            {error}
          </Typography.Paragraph>
        ) : null}
        {editing ? (
          <View className="gap-2 rounded-2xl bg-default p-3" testID="address-editor">
            <View className="flex-row items-center">
              <TextInput
                ref={addressInput}
                testID="address-input"
                accessibilityLabel="Website address"
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                selectTextOnFocus
                placeholder="Website address"
                placeholderTextColor={muted}
                style={{ color: foreground, minHeight: 44, fontSize: 17, flex: 1, minWidth: 0 }}
                value={address}
                onChangeText={setAddress}
                onSubmitEditing={openAddress}
              />
              {address ? (
                <Pressable
                  testID="clear-address"
                  accessibilityRole="button"
                  accessibilityLabel="Clear address"
                  className="min-h-11 justify-center px-2"
                  onPress={() => {
                    setAddress("");
                    addressInput.current?.focus();
                  }}
                >
                  <Typography>Clear</Typography>
                </Pressable>
              ) : null}
            </View>
            <View className="flex-row justify-end gap-5">
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setEditing(false)} className="min-h-11 justify-center px-2">
                <Typography>Cancel</Typography>
              </Pressable>
              <Pressable
                testID="open-address"
                accessibilityRole="button"
                accessibilityLabel="Open website"
                onPress={openAddress}
                className="min-h-11 justify-center px-2"
              >
                <Typography>Open</Typography>
              </Pressable>
            </View>
          </View>
        ) : hasPage ? (
          <NavigationToolbar
            canGoBack={navigation.canGoBack}
            canGoForward={navigation.canGoForward}
            isLoading={navigation.isLoading}
            onBack={() => run((current) => current.goBack())}
            onForward={() => run((current) => current.goForward())}
            onReload={() => run((current) => current.reload())}
            onStop={() => run((current) => current.stop())}
            onSearch={editAddress}
          />
        ) : (
          <StartToolbar onSearch={editAddress} />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
