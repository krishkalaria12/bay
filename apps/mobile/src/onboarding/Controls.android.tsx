import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Text as SvgText } from "react-native-svg";

import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, space } from "@/chrome/tokens";

import type { BackButtonProps, BackdropProps, NameProps, SkipButtonProps } from "./Controls.types";
import { useFirstRunColors } from "./palette";

// The welcome on Android: the same shapes as iOS, drawn the way Bay's Android surfaces are, flat translucent fills with
// a hairline edge and no imitation glass.

/** The ‹ button and Skip stand as tall as iOS's large glass buttons. */
const CONTROL = 44;

export function Backdrop({ radius, tone }: BackdropProps): JSX.Element {
  const colors = useFirstRunColors();
  const fill = tone === "night" ? "rgba(26,26,30,0.92)" : tone === "solid" ? colors.tile : colors.plate;
  const edge = tone === "night" ? "rgba(255,255,255,0.12)" : colors.hairline;

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: fill, borderWidth: StyleSheet.hairlineWidth, borderColor: edge }]}
    />
  );
}

export function BackButton({ testID, label, icon, visible, onPress }: BackButtonProps): JSX.Element {
  const colors = useFirstRunColors();

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      disabled={!visible}
      onPress={onPress}
      style={{
        width: CONTROL,
        height: CONTROL,
        borderRadius: CONTROL / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.plate,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.hairline,
        opacity: visible ? 1 : 0,
      }}
    >
      <Icon name={icon} color={colors.ink} size={iconSize.small} />
    </PressFeedback>
  );
}

export function SkipButton({ testID, label, visible, onPress }: SkipButtonProps): JSX.Element {
  const colors = useFirstRunColors();

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      disabled={!visible}
      onPress={onPress}
      style={{
        height: CONTROL,
        paddingHorizontal: space.lg,
        borderRadius: CONTROL / 2,
        justifyContent: "center",
        backgroundColor: colors.plate,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.hairline,
        opacity: visible ? 1 : 0,
      }}
    >
      <Text weight="medium" color={colors.ink}>
        {label}
      </Text>
    </PressFeedback>
  );
}

/** Inter's heaviest face, loaded with the others for the welcome's name (`useAppFonts`). */
export const NAME_FACE = "Inter_900Black";

export function Name({ text, width, height }: NameProps): JSX.Element {
  const colors = useFirstRunColors();
  // Inter's black letters fill about four fifths of the size from the cap height down: the size fits them to the box.
  const size = height * 1.24;

  return (
    <Svg width={width} height={height} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SvgText
        x={width / 2}
        y={height * 0.86}
        textAnchor="middle"
        fontFamily={NAME_FACE}
        fontSize={size}
        letterSpacing={-size * 0.045}
        fill={colors.plate}
        stroke={colors.hairline}
        strokeWidth={1.5}
      >
        {text}
      </SvgText>
    </Svg>
  );
}
