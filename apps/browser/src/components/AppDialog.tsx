import { Pressable, TextInput, View } from "@bay/platform";
import { setDialogPresenter, Surface, type ConfirmOptions, type ConfirmResult, type PromptOptions } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text } from "react-native";
import { create } from "zustand";
import { APP_ICON } from "../lib/assets";
import { useTheme } from "../lib/theme";
import { browserRead } from "../store/read";
import { useHover } from "./primitives";

// Dia's alert, for every confirm and prompt (@bay/shell's): in the window, the app's icon over a bold title and its
// message, then "Always …" where it can stop asking, Cancel (esc) and the action (↩), red when it destroys something.

type Request =
  | { id: number; windowId: string; kind: "confirm"; options: ConfirmOptions; resolve: (result: ConfirmResult) => void }
  | { id: number; windowId: string; kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

// The requests waiting, in order, and how many hosts each window has here.
const useDialogs = create<{ requests: Request[]; hosts: Record<string, number> }>(() => ({ requests: [], hosts: {} }));
let nextId = 1;

// The window named, else the focused one: null when no window in this document shows dialogs (the system's then).
function targetWindow(windowId: string | undefined): string | null {
  const { hosts } = useDialogs.getState();
  if (windowId) return hosts[windowId] ? windowId : null;
  const focused = browserRead.getState().ui.focusedWindowId;
  if (focused && hosts[focused]) return focused;
  return Object.keys(hosts).find((id) => hosts[id]) ?? null;
}

const enqueue = (request: Request) => useDialogs.setState((s) => ({ requests: [...s.requests, request] }));
const dequeue = (id: number) => useDialogs.setState((s) => ({ requests: s.requests.filter((r) => r.id !== id) }));

setDialogPresenter({
  confirm(options) {
    const windowId = targetWindow(options.windowId);
    if (!windowId) return null;
    return new Promise((resolve) => enqueue({ id: nextId++, windowId, kind: "confirm", options, resolve }));
  },
  prompt(options) {
    const windowId = targetWindow(options.windowId);
    if (!windowId) return null;
    return new Promise((resolve) => enqueue({ id: nextId++, windowId, kind: "prompt", options, resolve }));
  },
});

const cancelled = (request: Request) => (request.kind === "confirm" ? request.resolve({ confirmed: false, suppressed: false }) : request.resolve(null));

export function AppDialogHost({ windowId }: { windowId: string }) {
  const request = useDialogs((s) => s.requests.find((r) => r.windowId === windowId) ?? null);
  useEffect(() => {
    useDialogs.setState((s) => ({ hosts: { ...s.hosts, [windowId]: (s.hosts[windowId] ?? 0) + 1 } }));
    return () => {
      const remaining = (useDialogs.getState().hosts[windowId] ?? 1) - 1;
      if (remaining > 0) return void useDialogs.setState((s) => ({ hosts: { ...s.hosts, [windowId]: remaining } }));
      // A window that goes answers what it was asking: no.
      const orphans = useDialogs.getState().requests.filter((r) => r.windowId === windowId);
      useDialogs.setState((s) => {
        const { [windowId]: _gone, ...hosts } = s.hosts;
        return { hosts, requests: s.requests.filter((r) => r.windowId !== windowId) };
      });
      orphans.forEach(cancelled);
    };
  }, [windowId]);
  if (!request) return null;
  const finish = (answer: (request: Request) => void) => {
    dequeue(request.id);
    answer(request);
  };
  return <AppDialog key={request.id} request={request} finish={finish} />;
}

function AppDialog({ request, finish }: { request: Request; finish: (answer: (request: Request) => void) => void }) {
  const theme = useTheme();
  const dark = theme.dark;
  const prompt = request.kind === "prompt";
  const { title, message } = request.options;
  const [text, setText] = useState(request.kind === "prompt" ? (request.options.value ?? "") : "");
  const keys = useRef<View>(null);
  const input = useRef<TextInput>(null);
  useEffect(() => {
    const t = setTimeout(() => (prompt ? input.current?.focus() : (keys.current as unknown as { focus?: () => void } | null)?.focus?.()), 50);
    return () => clearTimeout(t);
  }, []);
  const cancel = () => finish(cancelled);
  const accept = (suppressed = false) => finish((r) => (r.kind === "confirm" ? r.resolve({ confirmed: true, suppressed }) : r.resolve(text)));
  const confirmTitle = request.options.confirmTitle ?? (prompt ? "OK" : "Confirm");
  const cancelTitle = request.kind === "confirm" ? (request.options.cancelTitle ?? "Cancel") : "Cancel";
  const destructive = request.kind === "confirm" && !!request.options.destructive;
  // Dia's "Always quit": the action that also stops the question.
  const always = request.kind === "confirm" && request.options.suppression ? `Always ${confirmTitle.toLowerCase()}` : null;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* The window under it dims and takes no clicks; a click there doesn't answer, as an alert's doesn't. */}
      <Pressable accessible={false} style={[StyleSheet.absoluteFill, { backgroundColor: dark ? "rgba(0,0,0,0.38)" : "rgba(0,0,0,0.18)" }]} />
      <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
        <Surface
          fill={dark ? "#1E1E1E" : "#FFFFFF"}
          cornerRadius={14}
          borderColor={dark ? "#FFFFFF1F" : "#0000001A"}
          borderWidth={1}
          shadowColor="#000000"
          shadowOpacity={dark ? 0.5 : 0.18}
          shadowRadius={32}
          shadowOffset={[0, 14]}
          style={{ width: 420, maxWidth: "100%" }}
        >
          <View
            ref={keys}
            focusable
            enableFocusRing={false}
            accessibilityRole="alert"
            accessibilityLabel={title}
            keyDownEvents={[{ key: "Escape" }, { key: "Enter" }]}
            onKeyDown={(e) => (e.nativeEvent.key === "Escape" ? cancel() : accept())}
            style={{ padding: 24 }}
          >
            <View style={{ width: 28, height: 28, borderRadius: 7, overflow: "hidden", backgroundColor: "#FFFFFF", ...ICON_SHADOW }}>
              <Image source={APP_ICON} style={{ width: 28, height: 28 }} />
            </View>
            <Text style={{ marginTop: 16, fontSize: 17, fontWeight: "700", color: theme.textPrimary }}>{title}</Text>
            {message ? (
              <Text style={{ marginTop: 8, fontSize: 13, lineHeight: 18, color: dark ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.62)" }}>{message}</Text>
            ) : null}
            {request.kind === "prompt" ? (
              <View
                style={{
                  marginTop: 14,
                  height: 34,
                  borderRadius: 9,
                  borderWidth: 2,
                  borderColor: theme.accent,
                  backgroundColor: dark ? "rgba(0,0,0,0.25)" : "#FFFFFF",
                  justifyContent: "center",
                  paddingHorizontal: 9,
                }}
              >
                <TextInput
                  ref={input}
                  value={text}
                  onChangeText={setText}
                  placeholder={request.options.placeholder}
                  placeholderTextColor={theme.placeholder}
                  selectionColor={theme.selection}
                  selectTextOnFocus
                  enableFocusRing={false}
                  onSubmitEditing={() => accept()}
                  keyDownEvents={[{ key: "Escape" }]}
                  onKeyDown={cancel}
                  style={{ fontSize: 14, color: theme.textPrimary, paddingVertical: 0, paddingHorizontal: 0 }}
                />
              </View>
            ) : null}
            <View style={{ marginTop: 22, flexDirection: "row", alignItems: "center", gap: 8 }}>
              {always ? <DialogButton title={always} onPress={() => accept(true)} /> : null}
              <View style={{ flex: 1 }} />
              <DialogButton title={cancelTitle} keyCap="ESC" onPress={cancel} />
              <DialogButton title={confirmTitle} keyCap="↩" primary={destructive ? "destructive" : "default"} onPress={() => accept()} />
            </View>
          </View>
        </Surface>
      </View>
    </View>
  );
}

const ICON_SHADOW = { shadowColor: "#000000", shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } };
const DESTRUCTIVE = "#D9271C";

function buttonFill(primary: "default" | "destructive" | undefined, dark: boolean, hovered: boolean, accent: string) {
  if (primary === "destructive") return DESTRUCTIVE;
  if (primary) return accent;
  if (dark) return hovered ? "#3A3A3C" : "#2C2C2E";
  return hovered ? "rgba(0,0,0,0.1)" : "rgba(0,0,0,0.06)";
}

function DialogButton({ title, keyCap, primary, onPress }: { title: string; keyCap?: string; primary?: "default" | "destructive"; onPress: () => void }) {
  const theme = useTheme();
  const dark = theme.dark;
  const { hovered, hoverProps } = useHover();
  const fill = buttonFill(primary, dark, hovered, theme.accent);
  const ink = primary ? "#FFFFFF" : theme.textPrimary;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
        {({ pressed }) => (
          <View
            style={{
              height: 34,
              borderRadius: 9,
              paddingHorizontal: 14,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: fill,
              opacity: pressed ? 0.8 : primary && hovered ? 0.92 : 1,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "500", color: ink }}>{title}</Text>
            {keyCap === "ESC" ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.18)",
                  borderRadius: 4,
                  paddingHorizontal: 4,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ fontSize: 9, fontWeight: "700", letterSpacing: 0.5, color: dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)" }}>ESC</Text>
              </View>
            ) : keyCap ? (
              <Text style={{ fontSize: 15, fontWeight: "600", color: "rgba(255,255,255,0.7)" }}>{keyCap}</Text>
            ) : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}
