import { Surface, Symbol, VisualEffect } from "@bay/shell";
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { useDefaultBrowserCheckIn } from "../../lib/defaultBrowserCheckIn";
import { CHECK_IN_COPY } from "../../lib/constants";
import { hex, useTheme } from "../../lib/theme";
import { useHover } from "../primitives";
import { APP_ICON } from "../../lib/assets";
import { CHECK_IN_FRAME } from "./constants";

export function CheckInBanner({ windowId }: { windowId: string }) {
  const checkIn = useDefaultBrowserCheckIn(windowId);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  if (!checkIn.visible && !leaving) return null;
  const retire = (action: () => void) =>
    setLeaving(() => () => {
      action();
      setLeaving(null);
    });
  return (
    <View style={{ position: "absolute", left: 0, top: 0, width: CHECK_IN_FRAME.width, height: CHECK_IN_FRAME.height, padding: 8 }} pointerEvents="box-none">
      <Card leaving={leaving} onFeedback={() => retire(checkIn.leaveFeedback)} onClose={() => retire(checkIn.dismiss)} />
    </View>
  );
}

function Card({ leaving, onFeedback, onClose }: { leaving: null | (() => void); onFeedback: () => void; onClose: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.set(withDelay(300, withTiming(1, { duration: 300, easing: Easing.out(Easing.quad) })));
  }, []);
  useEffect(() => {
    if (leaving) return;
    const stiffness = ((2 * Math.PI) / 0.2) ** 2;
    scale.set(withSpring(pressed ? 0.98 : hovered ? 1.02 : 1, { stiffness, damping: 2 * 0.5 * Math.sqrt(stiffness), mass: 1 }));
  }, [hovered, pressed, !!leaving]);
  useEffect(() => {
    if (!leaving) return;
    const leave = () => leaving();
    scale.set(withTiming(0.98, { duration: 220, easing: Easing.out(Easing.quad) }));
    opacity.set(
      withTiming(0, { duration: 220, easing: Easing.out(Easing.quad) }, () => {
        runOnJS(leave)();
      }),
    );
  }, [leaving]);

  const cardStyle = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ scale: scale.get() }] }));
  return (
    <Animated.View {...hoverProps} style={[{ flex: 1 }, cardStyle]} pointerEvents={leaving ? "none" : "auto"}>
      <Pressable
        onPress={onFeedback}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="button"
        accessibilityLabel={`${CHECK_IN_COPY.title} ${CHECK_IN_COPY.action}`}
        style={{ flex: 1 }}
      >
        <Surface
          style={StyleSheet.absoluteFill}
          fill={theme.dark ? "#FFFFFF17" : "#FFFFFF80"}
          cornerRadius={10}
          borderColor={theme.dark ? "#FFFFFF0A" : "#00000014"}
          borderWidth={1}
          shadowColor="#000000"
          shadowOpacity={theme.dark ? 0.3 : 0.1}
          shadowRadius={24}
          shadowOffset={[0, 8]}
        />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, gap: 10 }}>
          <View style={{ width: 37, height: 37, borderRadius: 6, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
            <Image source={APP_ICON} style={{ width: 37, height: 37 }} />
          </View>
          <View style={{ flex: 1, gap: 2, paddingLeft: 4 }}>
            <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: theme.dark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.8)" }}>
              {CHECK_IN_COPY.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
              <Text style={{ fontSize: 12, color: theme.dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.53)" }}>{CHECK_IN_COPY.action}</Text>
              <Symbol name="arrow.up.right" size={9} weight="medium" color={theme.dark ? "#FFFFFF99" : "#00000087"} style={{ width: 11, height: 11 }} />
            </View>
          </View>
        </View>
      </Pressable>
      <View style={{ position: "absolute", right: -8, top: -8, opacity: hovered ? 1 : 0 }} pointerEvents={hovered ? "auto" : "none"}>
        <CloseButton onPress={onClose} />
      </View>
    </Animated.View>
  );
}

function CloseButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const fill = theme.dark ? (hovered ? "#FFFFFF4D" : "#FFFFFF14") : hovered ? "#0000004D" : "#00000033";
  return (
    <View {...hoverProps} tooltip="Dismiss">
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Dismiss">
        <View style={{ width: 23, height: 23, borderRadius: 11.5, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
          <VisualEffect material="hudWindow" blendingMode="withinWindow" cornerRadius={11.5} style={StyleSheet.absoluteFill} />
          <Surface style={StyleSheet.absoluteFill} fill={hex(fill)} cornerRadius={11.5} borderColor={theme.dark ? "#FFFFFF1F" : "#00000014"} borderWidth={1} />
          <Symbol name="xmark" size={10} weight="medium" color="#FFFFFFE6" style={{ width: 23, height: 23 }} />
        </View>
      </Pressable>
    </View>
  );
}
