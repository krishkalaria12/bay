import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Alert, View } from "react-native";

import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { inputFont, radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { PERSONAL_SPACE_ID, SPACE_COLORS, SPACE_EMOJI } from "@/store/model";
import type { SpaceColor } from "@/store/types";

import { ActionRow, Group, PanelSheet, SectionLabel } from "./PanelSheet";
import { quietWhileClosed } from "./quietWhileClosed";

/** How many emoji a row holds. */
const ACROSS = 7;

export interface SpaceEditPanelProps {
  visible: boolean;
  onClose: () => void;
  /** The space being edited, as the user sees its name. */
  id: string;
  name: string;
  /** The name as saved, which the field starts from. */
  savedName: string;
  icon: string | null;
  color: SpaceColor;
  /** Each colour's swatch, as the switcher draws it. */
  swatches: Record<SpaceColor, string>;
  /** Where the space sits in the bar, and how many there are. */
  index: number;
  count: number;
  onRename: (name: string) => void;
  onIcon: (icon: string) => void;
  onColor: (color: SpaceColor) => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}

/**
 * Everything about a space, in one sheet, as the desktop's space settings: its name, its emoji (from the desktop's
 * set, which it syncs as), its colour, its place in the bar, and deleting it with what it kept.
 */
function SpaceEditPanelSheet(props: SpaceEditPanelProps): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  const [name, setName] = useState(props.savedName);

  // Another space opened in the sheet starts from its own name.
  useEffect(() => setName(props.savedName), [props.id, props.savedName]);

  function saveName(): void {
    const trimmed = name.trim();

    if (trimmed && trimmed !== props.savedName) props.onRename(trimmed);
    else setName(props.savedName);
  }

  function confirmDelete(): void {
    Alert.alert(t("space.edit.delete.title", { name: props.name }), t("space.edit.delete.message"), [
      { text: t("space.edit.delete.cancel"), style: "cancel" },
      { text: t("space.edit.delete.action"), style: "destructive", onPress: props.onDelete },
    ]);
  }

  const personal = props.id === PERSONAL_SPACE_ID;

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title={t("space.edit.title", { name: props.name })} testID="space-edit" height="85%">
      <SectionLabel>{t("space.edit.name")}</SectionLabel>
      <View className="flex-row items-center rounded-full bg-default px-4">
        <BottomSheetTextInput
          testID="space-edit-name"
          accessibilityLabel={t("space.edit.name")}
          value={name}
          onChangeText={setName}
          onEndEditing={saveName}
          onSubmitEditing={saveName}
          returnKeyType="done"
          maxLength={40}
          style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 10 }]}
        />
      </View>

      <SectionLabel>{t("space.edit.color")}</SectionLabel>
      <View className="flex-row" style={{ gap: space.sm }}>
        {SPACE_COLORS.map((color) => {
          const chosen = color === props.color;

          return (
            <PressFeedback
              key={color}
              testID={`space-edit-color-${color}`}
              accessibilityRole="radio"
              accessibilityLabel={t(`space.color.${color}`)}
              accessibilityState={{ selected: chosen, checked: chosen }}
              onPress={() => props.onColor(color)}
              className="items-center justify-center rounded-full"
              style={{ width: 40, height: 40, borderWidth: 2, borderColor: chosen ? props.swatches[color] : "transparent" }}
            >
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: props.swatches[color] }} />
            </PressFeedback>
          );
        })}
      </View>

      <SectionLabel>{t("space.edit.icon")}</SectionLabel>
      <View className="flex-row flex-wrap" style={{ gap: space.xs }}>
        {SPACE_EMOJI.map((emoji, at) => {
          const chosen = emoji === props.icon;

          return (
            <PressFeedback
              key={emoji}
              testID={`space-icon-${at}`}
              accessibilityRole="radio"
              accessibilityLabel={emoji}
              accessibilityState={{ selected: chosen, checked: chosen }}
              onPress={() => props.onIcon(emoji)}
              className={`items-center justify-center ${chosen ? "bg-accent/20" : "bg-default"}`}
              style={{ width: `${100 / ACROSS - 1.2}%`, aspectRatio: 1, borderRadius: radius.control }}
            >
              <Text style={{ fontSize: 24, lineHeight: 30 }}>{emoji}</Text>
            </PressFeedback>
          );
        })}
      </View>

      <View style={{ marginTop: space.sm, gap: space.lg }}>
        <Group label={t("space.edit.order")}>
          <ActionRow testID="space-edit-move-left" icon="back" label={t("space.edit.moveLeft")} disabled={props.index <= 0} onPress={() => props.onMove(-1)} />
          <ActionRow
            testID="space-edit-move-right"
            icon="forward"
            label={t("space.edit.moveRight")}
            disabled={props.index >= props.count - 1}
            onPress={() => props.onMove(1)}
          />
        </Group>
        <Group>
          <ActionRow
            testID="space-edit-delete"
            icon="delete"
            label={t("space.edit.delete", { name: props.name })}
            detail={personal ? t("space.edit.delete.personal") : t("space.edit.delete.detail")}
            destructive
            disabled={personal || props.count < 2}
            onPress={confirmDelete}
          />
        </Group>
      </View>
    </PanelSheet>
  );
}

export const SpaceEditPanel = quietWhileClosed(SpaceEditPanelSheet);
