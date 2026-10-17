import { Pressable, TextInput, View } from "@bay/platform";
import { Surface } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text } from "react-native";
import { create } from "zustand";
import { onEscapeKey } from "../lib/escapeKey";
import { hex, useTheme } from "../lib/theme";
import { useWindowId } from "../store/hooks";
import { useHover } from "./primitives";

// yab's rename dialog: a panel in the middle of the page with the thing's icon in a tile, "Rename <name>", the name
// selected in a field, and Cancel (esc) and Rename (↩). For what has no row to rename in place: a space.

type Request = {
  windowId: string;
  title: string;
  value: string;
  placeholder: string;
  confirmTitle: string;
  icon: ReactNode;
  resolve: (name: string | null) => void;
};

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** The name typed, trimmed, or null when cancelled or left empty. */
export function requestRename(options: Omit<Request, "resolve" | "confirmTitle" | "placeholder"> & { confirmTitle?: string; placeholder?: string }) {
  return new Promise<string | null>((resolve) => {
    useRequest.getState().request?.resolve(null);
    useRequest.setState({ request: { confirmTitle: "Rename", placeholder: "Name", ...options, resolve } });
  });
}

/** `pageLeft` and `pageRight`: the sidebar's room on either side, so the dialog centres on the page beside it. */
export function RenameDialogHost({ pageLeft, pageRight }: { pageLeft: number; pageRight: number }) {
  const windowId = useWindowId();
  const request = useRequest((r) => (r.request?.windowId === windowId ? r.request : null));
  if (!request) return null;
  const done = (name: string | null) => {
    useRequest.setState({ request: null });
    request.resolve(name?.trim() || null);
  };
  return <RenameDialog key={request.title} request={request} onDone={done} pageLeft={pageLeft} pageRight={pageRight} />;
}

function RenameDialog({
  request,
  onDone,
  pageLeft,
  pageRight,
}: {
  request: Request;
  onDone: (name: string | null) => void;
  pageLeft: number;
  pageRight: number;
}) {
  const theme = useTheme();
  const [text, setText] = useState(request.value);
  const input = useRef<TextInput>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  const cancel = () => onDone(null);
  const confirm = () => onDone(text);
  const tile = theme.dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)";

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={cancel} />
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", left: pageLeft, right: pageRight, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}
      >
        <Surface
          fill={hex(theme.panel)}
          cornerRadius={20}
          borderColor={hex(theme.panelBorder)}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={30}
          shadowOffset={[0, 12]}
          style={{ width: 420, padding: 14, flexDirection: "row", gap: 12 }}
        >
          <View style={{ width: 52, height: 52, borderRadius: 13, backgroundColor: tile, alignItems: "center", justifyContent: "center" }}>{request.icon}</View>
          <View style={{ flex: 1, gap: 9 }}>
            <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary, marginTop: 2 }}>
              {request.title}
            </Text>
            <View
              style={{
                height: 32,
                borderRadius: 9,
                borderWidth: 2,
                borderColor: theme.accent,
                backgroundColor: theme.dark ? "rgba(0,0,0,0.25)" : "#FFFFFF",
                justifyContent: "center",
                paddingHorizontal: 8,
              }}
            >
              <TextInput
                ref={input}
                value={text}
                onChangeText={setText}
                placeholder={request.placeholder}
                placeholderTextColor={theme.placeholder}
                selectionColor={theme.selection}
                selectTextOnFocus
                enableFocusRing={false}
                onSubmitEditing={confirm}
                keyDownEvents={[{ key: "Escape" }]}
                onKeyPress={onEscapeKey(cancel)}
                style={{ fontSize: 14, color: theme.textPrimary, paddingVertical: 0, paddingHorizontal: 0 }}
              />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <KeyButton title="Cancel" keyCap="esc" onPress={cancel} />
              <KeyButton title={request.confirmTitle} keyCap="↩" primary disabled={!text.trim()} onPress={confirm} />
            </View>
          </View>
        </Surface>
      </View>
    </View>
  );
}

// The confirming button is solid (light on dark windows, dark on light ones); Cancel is a faint fill that deepens on hover.
function keyButtonColors(primary: boolean, dark: boolean, hovered: boolean, text: string) {
  if (primary && dark) return { fill: "#F2F2F2", ink: "#1C1C1E", cap: "rgba(0,0,0,0.12)" };
  if (primary) return { fill: "#1C1C1E", ink: "#FFFFFF", cap: "rgba(255,255,255,0.2)" };
  if (dark) return { fill: hovered ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.07)", ink: text, cap: "rgba(255,255,255,0.12)" };
  return { fill: hovered ? "rgba(0,0,0,0.09)" : "rgba(0,0,0,0.05)", ink: text, cap: "rgba(0,0,0,0.08)" };
}

// A button with its key beside its title, as yab's dialogs have.
function KeyButton({
  title,
  keyCap,
  primary,
  disabled,
  onPress,
}: {
  title: string;
  keyCap: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const { fill, ink, cap } = keyButtonColors(!!primary, theme.dark, hovered, theme.textPrimary);
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} disabled={disabled}>
        {({ pressed }) => (
          <View
            style={{
              height: 30,
              borderRadius: 9,
              paddingLeft: 12,
              paddingRight: 4,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: fill,
              opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "500", color: ink }}>{title}</Text>
            <View
              style={{ minWidth: 22, height: 22, borderRadius: 6, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: cap }}
            >
              <Text style={{ fontSize: 11, fontWeight: "600", color: ink }}>{keyCap}</Text>
            </View>
          </View>
        )}
      </Pressable>
    </View>
  );
}
