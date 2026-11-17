import type { JSX } from "react";
import { View } from "react-native";

import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { radius, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { SPACE_EMOJI } from "@/store/model";

import { ActionRow, Group, PanelSheet } from "./PanelSheet";
import { quietWhileClosed } from "./quietWhileClosed";

/** How many emoji a row holds. */
const ACROSS = 7;

/**
 * A space's emoji, from the desktop's set (it syncs as the space's icon there), or none, when the space shows its
 * name's first letter.
 */
function SpaceIconPanelSheet({
  visible,
  onClose,
  name,
  icon,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  name: string;
  icon: string | null;
  onPick: (icon: string | null) => void;
}): JSX.Element {
  const t = useT();

  return (
    <PanelSheet visible={visible} onClose={onClose} title={t("space.icon.title", { name })} testID="space-icon" height="70%">
      <View className="flex-row flex-wrap" style={{ gap: space.xs }}>
        {SPACE_EMOJI.map((emoji) => {
          const chosen = emoji === icon;

          return (
            <PressFeedback
              key={emoji}
              testID={`space-icon-${SPACE_EMOJI.indexOf(emoji)}`}
              accessibilityRole="radio"
              accessibilityLabel={emoji}
              accessibilityState={{ selected: chosen, checked: chosen }}
              onPress={() => onPick(emoji)}
              className={`items-center justify-center ${chosen ? "bg-accent/20" : "bg-default"}`}
              style={{ width: `${100 / ACROSS - 1.2}%`, aspectRatio: 1, borderRadius: radius.control }}
            >
              <Text style={{ fontSize: 24, lineHeight: 30 }}>{emoji}</Text>
            </PressFeedback>
          );
        })}
      </View>
      <View style={{ marginTop: space.lg }}>
        <Group>
          <ActionRow testID="space-icon-letter" label={t("space.icon.letter")} selected={!icon} onPress={() => onPick(null)} />
        </Group>
      </View>
    </PanelSheet>
  );
}

export const SpaceIconPanel = quietWhileClosed(SpaceIconPanelSheet);
