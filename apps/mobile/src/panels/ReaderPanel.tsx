import { useThemeColor } from "heroui-native";
import type { JSX } from "react";
import { Pressable, Text, View } from "react-native";
import { READER_FONTS, READER_SIZES, READER_THEMES, type ReaderSettings } from "@/pagescripts/reader";
import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

export function ReaderPanel({
  visible,
  settings,
  onChange,
  onClose,
  onExit,
}: {
  visible: boolean;
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onClose: () => void;
  onExit: () => void;
}): JSX.Element {
  const accent = useThemeColor("accent");

  return (
    <PanelSheet visible={visible} onClose={onClose} title="Reader" testID="reader-settings" height="60%">
      <ActionRow testID="reader-exit" label="Exit Reader" onPress={onExit} />
      <SectionLabel>Text size</SectionLabel>
      <View className="flex-row items-center gap-2">
        <Choice
          id="reader-smaller"
          label="Smaller"
          disabled={settings.size <= READER_SIZES.min}
          onPress={() => onChange({ ...settings, size: settings.size - 1 })}
        />
        <Text testID="reader-size" className="w-10 text-center text-foreground">
          {settings.size}
        </Text>
        <Choice
          id="reader-larger"
          label="Larger"
          disabled={settings.size >= READER_SIZES.max}
          onPress={() => onChange({ ...settings, size: settings.size + 1 })}
        />
      </View>
      <SectionLabel>Font</SectionLabel>
      <View className="flex-row gap-2">
        {READER_FONTS.map((font) => (
          <Choice
            key={font.id}
            id={`reader-font-${font.id}`}
            label={font.name}
            selected={settings.font === font.id}
            onPress={() => onChange({ ...settings, font: font.id })}
          />
        ))}
      </View>
      <SectionLabel>Theme</SectionLabel>
      <View className="flex-row justify-between">
        {READER_THEMES.map((theme) => {
          const selected = settings.theme === theme.id;

          return (
            <Pressable
              key={theme.id}
              testID={`reader-theme-${theme.id}`}
              accessibilityRole="button"
              accessibilityLabel={theme.name}
              accessibilityState={{ selected }}
              onPress={() => onChange({ ...settings, theme: theme.id })}
              className="size-11 items-center justify-center rounded-full border-2"
              style={{ borderColor: selected ? accent : "transparent" }}
            >
              <View
                className="size-9 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.background, borderWidth: 1, borderColor: "rgba(127,127,127,0.35)" }}
              >
                <Text style={{ color: theme.text, fontSize: 14 }}>Aa</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </PanelSheet>
  );
}

function Choice({ id, label, selected, disabled, onPress }: { id: string; label: string; selected?: boolean; disabled?: boolean; onPress: () => void }) {
  const accent = useThemeColor("accent");

  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 flex-1 items-center justify-center rounded-2xl border-2 bg-default px-3"
      style={{ opacity: disabled ? 0.4 : 1, borderColor: selected ? accent : "transparent" }}
    >
      <Text className="text-sm text-foreground">{label}</Text>
    </Pressable>
  );
}
