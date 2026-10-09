import type { BrowserSource, SpaceSummary } from "@bay/import";
import { Symbol, VisualEffect, WindowDragRegion } from "@bay/shell";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { APP_NAME } from "../../lib/constants";
import { useTheme } from "../../lib/theme";
import { useProfiles } from "../../store/hooks";
import { plural } from "../../store/model";
import { useHover } from "../primitives";
import { Button, Checkbox, PopUp, useFormColors } from "../settings/controls";
import { CHECK_SPRING, SUCCESS_SPRING } from "./constants";
import type { Status } from "./useImportFlow";

/** The window's backdrop, the same under every step (a step's own views come and go with it). */
export function ImportBackdrop({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.dark ? "#1E1E1E" : "#F4F4F4" }}>
      <VisualEffect material="windowBackground" blendingMode="behindWindow" style={StyleSheet.absoluteFill} />
      <WindowDragRegion style={{ position: "absolute", left: 0, right: 0, top: 0, height: 40 }} />
      {children}
    </View>
  );
}

/** A step: its content scrolls, its buttons sit in the bar at the foot. */
export function StepLayout({ footer, children }: { footer: ReactNode; children: ReactNode }) {
  const theme = useTheme();
  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 32, paddingTop: 46, paddingBottom: 20 }}>
        {children}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 20,
          height: 56,
          borderTopWidth: StyleSheet.hairlineWidth * 2,
          borderTopColor: theme.divider,
        }}
      >
        {footer}
      </View>
    </>
  );
}

/** The profile the import goes into, with more than one to choose from. */
export function TargetPicker({ value, onChange }: { value: string; onChange: (profileId: string) => void }) {
  const theme = useTheme();
  const profiles = useProfiles();
  if (profiles.length < 2) return <View />;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ fontSize: 12, color: theme.textSecondary }}>Import into</Text>
      <PopUp value={value} options={profiles.map((p) => ({ value: p.id, title: p.name }))} onChange={onChange} minWidth={130} />
    </View>
  );
}

export function Spacer() {
  return <View style={{ flex: 1 }} />;
}

export function Title({ title, subtitle, spinner }: { title: string; subtitle?: string; spinner?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: theme.textPrimary }}>{title}</Text>
      {subtitle ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
          {spinner && <ActivityIndicator size="small" />}
          <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: theme.textSecondary }}>{subtitle}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function Note({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={{ fontSize: 13, color: theme.textSecondary, marginTop: 20, textAlign: "center" }}>{text}</Text>;
}

export function ErrorText({ text }: { text: string }) {
  return <Text style={{ fontSize: 12, marginTop: 12, color: "#FF9F0A" }}>{text}</Text>;
}

/** The source browser's icon handing over to what it's asked for (a keychain item, AppleScript). */
export function Handoff({ iconPath, symbol }: { iconPath?: string; symbol: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      {iconPath ? <Image source={{ uri: `file://${iconPath}` }} style={{ width: 56, height: 56 }} /> : null}
      <Symbol name="arrow.right" size={16} color={theme.textTertiary} style={{ width: 20, height: 20 }} />
      <Symbol name={symbol} size={30} color={theme.icon} style={{ width: 56, height: 56 }} />
    </View>
  );
}

export function BrowserRow({ browser, selected, onPress }: { browser: BrowserSource; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const { hovered, hoverProps } = useHover();
  const spaces = browser.profiles.reduce((n, p) => n + (p.spaces?.length ?? 0), 0);
  const detail = browser.needsFullDiskAccess
    ? "Needs Full Disk Access"
    : browser.family === "automation"
      ? "Asks Dia while it's open"
      : browser.requiresExport
        ? "Direct or from an exported .zip"
        : browser.family === "arc" && spaces
          ? plural(spaces, "space")
          : browser.profiles.length > 1
            ? plural(browser.profiles.length, "profile")
            : "";
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View
          style={{
            height: 52,
            borderRadius: 10,
            paddingHorizontal: 12,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            backgroundColor: selected ? `${colors.accent}26` : hovered ? colors.selected : colors.group,
            borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth * 2,
            borderColor: selected ? colors.accent : colors.groupBorder,
          }}
        >
          <Radio on={selected} />
          {browser.iconPath ? (
            <Image source={{ uri: `file://${browser.iconPath}` }} style={{ width: 32, height: 32 }} />
          ) : (
            <Symbol name="globe" size={22} color={theme.icon} style={{ width: 32, height: 32 }} />
          )}
          <Text style={{ flex: 1, fontSize: 14, fontWeight: "500", color: theme.textPrimary }}>{browser.name}</Text>
          {detail ? <Text style={{ fontSize: 12, color: theme.textSecondary }}>{detail}</Text> : null}
          {browser.needsKeychain && <Symbol name="lock" size={11} color={theme.textTertiary} style={{ width: 14, height: 14 }} />}
        </View>
      </Pressable>
    </View>
  );
}

function Radio({ on }: { on: boolean }) {
  const colors = useFormColors();
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: on ? colors.accent : colors.control,
        borderWidth: on ? 0 : 1,
        borderColor: colors.controlBorder,
      }}
    >
      {on && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#FFFFFF" }} />}
    </View>
  );
}

export function SelectRow({ selected, onToggle, icon, title, subtitle }: { selected: boolean; onToggle: (v: boolean) => void; icon: ReactNode; title: string; subtitle?: string }) {
  const theme = useTheme();
  const colors = useFormColors();
  return (
    <Pressable onPress={() => onToggle(!selected)}>
      <View
        style={{
          minHeight: 48,
          borderRadius: 10,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: colors.group,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: colors.groupBorder,
        }}
      >
        <Checkbox value={selected} onChange={onToggle} />
        {icon}
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13.5, color: theme.textPrimary }}>{title}</Text>
          {subtitle ? <Text style={{ fontSize: 11.5, marginTop: 1, color: theme.textSecondary }}>{subtitle}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

export function Monogram({ name, color }: { name: string; color?: string }) {
  return (
    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: color ?? "#8E8E93", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: "#FFFFFF" }}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

export function SpaceIcon({ space }: { space: SpaceSummary }) {
  return (
    <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: space.color ?? "#8E8E93", alignItems: "center", justifyContent: "center" }}>
      {space.emoji ? <Text style={{ fontSize: 15 }}>{space.emoji}</Text> : <Symbol name="square.stack" size={12} color="#FFFFFF" style={{ width: 16, height: 16 }} />}
    </View>
  );
}

export function CategoryRow({ title, icon, status, index }: { title: string; icon: string; status: Status; index: number }) {
  const theme = useTheme();
  const colors = useFormColors();
  const appear = useSharedValue(0);
  const check = useSharedValue(0);
  useEffect(() => {
    appear.set(withDelay(index * 70, withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) })));
  }, []);
  useEffect(() => {
    if (status === "done" || status === "failed") check.set(withSpring(1, CHECK_SPRING));
  }, [status]);
  const appearStyle = useAnimatedStyle(() => ({ opacity: appear.get(), transform: [{ translateY: interpolate(appear.get(), [0, 1], [8, 0]) }] }));
  const checkStyle = useAnimatedStyle(() => ({ transform: [{ scale: check.get() }] }));
  const active = status === "active";
  return (
    <Animated.View
      style={[
        appearStyle,
        {
          height: 44,
          borderRadius: 10,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: active ? `${colors.accent}1F` : colors.group,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: active ? `${colors.accent}66` : colors.groupBorder,
        },
      ]}
    >
      <Symbol name={icon} size={13} color={status === "pending" ? theme.textTertiary : theme.icon} style={{ width: 20, height: 20 }} />
      <Text style={{ flex: 1, fontSize: 13, color: status === "pending" ? theme.textSecondary : theme.textPrimary }}>{title}</Text>
      {active ? (
        <ActivityIndicator size="small" />
      ) : status === "pending" ? null : (
        <Animated.View style={checkStyle}>
          <Symbol
            name={status === "done" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"}
            size={15}
            color={status === "done" ? "#30D158" : "#FF9F0A"}
            style={{ width: 20, height: 20 }}
          />
        </Animated.View>
      )}
    </Animated.View>
  );
}

export function SuccessMark() {
  const scale = useSharedValue(0.4);
  useEffect(() => {
    scale.set(withSpring(1, SUCCESS_SPRING));
  }, []);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <Animated.View style={scaleStyle}>
      <Symbol name="checkmark.circle.fill" size={46} color="#30D158" style={{ width: 60, height: 60 }} />
    </Animated.View>
  );
}

export function FullDiskAccessSteps({ onOpen, onRecheck }: { onOpen: () => void; onRecheck: () => void }) {
  return (
    <SettingsSteps
      steps={["Click “Open Full Disk Access Settings” below", `Turn on ${APP_NAME} in the list`, "Come back here: we'll continue automatically"]}
      openTitle="Open Full Disk Access Settings"
      onOpen={onOpen}
      onRecheck={onRecheck}
    />
  );
}

export function SettingsSteps({ steps, openTitle, onOpen, onRecheck }: { steps: string[]; openTitle: string; onOpen: () => void; onRecheck: () => void }) {
  const theme = useTheme();
  return (
    <>
      <View style={{ gap: 10, marginBottom: 16 }}>
        {steps.map((t, i) => (
          <View key={t} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: theme.rowHover, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSecondary }}>{i + 1}</Text>
            </View>
            <Text style={{ fontSize: 13, color: theme.textPrimary }}>{t}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <Button title={openTitle} kind="primary" onPress={onOpen} />
        <Button title="Check Again" onPress={onRecheck} />
      </View>
    </>
  );
}

export function FileDrop({ onFile, onChoose }: { onFile: (path: string) => void; onChoose: () => Promise<string | null> }) {
  const theme = useTheme();
  const colors = useFormColors();
  const [over, setOver] = useState(false);
  return (
    <View
      draggedTypes={["fileUrl"]}
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const uri = e.nativeEvent.dataTransfer?.files?.[0]?.uri;
        if (uri) onFile(decodeURIComponent(uri.replace(/^file:\/\//, "")));
      }}
      style={{
        height: 130,
        borderRadius: 12,
        borderWidth: 1.5,
        borderStyle: "dashed",
        borderColor: over ? colors.accent : theme.dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.2)",
        backgroundColor: over ? `${colors.accent}1A` : undefined,
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <Symbol name="doc.zipper" size={24} color={theme.textSecondary} style={{ width: 32, height: 32 }} />
      <Text style={{ fontSize: 13, color: theme.textSecondary }}>Choose .zip file or drag it here</Text>
      <Button
        title="Choose .zip file"
        onPress={() =>
          void onChoose().then((path) => {
            if (path) onFile(path);
          })
        }
      />
    </View>
  );
}
