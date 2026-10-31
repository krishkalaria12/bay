import { Pressable, ScrollView, TextInput, View } from "@bay/platform";
import { useShallow } from "zustand/react/shallow";
import { fontFamilies, showMenu, Surface, Symbol, type MenuItem } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanResponder, Text, type GestureResponderEvent } from "react-native";
import { BOOST_CASES, BOOST_FONTS, BOOST_SIZES, DEFAULT_BOOST_COLOR, tintEnds, type Boost, type BoostColor, type BoostTextCase } from "../../lib/boosts";
import { hex, useTheme } from "../../lib/theme";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { webviews } from "../../lib/webviews";
import { Toggle } from "../layout/controls";
import { IconButton, useHover } from "../primitives";
import { ColorField } from "../spaces/ThemeEditor";
import {
  closeBoostEditor,
  exportBoostFile,
  importBoostFile,
  openBoostEditor,
  previewZap,
  removeBoost,
  renameBoost,
  resetBoost,
  setEditorView,
  shuffleBoost,
  startPicking,
  stopPicking,
  switchEditorBoost,
  toggleBoostScript,
  useEditorSession,
  type EditorSession,
} from "./editor";
import { boostsForHost, removeSelector, setBoostScript, updateBoost, useBoosts } from "./state";

// The Boost editor, as Arc's and Zen's: a panel over the page's corner, the page itself the preview. Colours on a
// wheel (two dots: the dark end and the light end of the tint), Invert, the advanced sliders and the space's colours;
// fonts; size and case; Zap and Focus; then Code (CSS, and this Mac's JavaScript).
const WIDTH = 268;
const PAD = 12;
const FIELD = WIDTH - 2 * PAD;
const CASE_TITLES: Record<BoostTextCase, string> = { none: "Aa", capitalize: "Ab", uppercase: "AB", lowercase: "ab" };
// The small dot's places round the wheel from the big one: Arc's soft pair first, then contrasts.
const SPREADS = [40, 180, 150, 310, 0];

export function BoostEditor({ tabId, right = 10, top = 10, maxHeight }: { tabId: string; right?: number; top?: number; maxHeight: number }) {
  const theme = useTheme();
  const session = useEditorSession(tabId);
  const boost = useBoosts((s) => (session ? s.boosts[session.boostId] : undefined));
  if (!session || !boost) return null;
  return (
    <Surface
      fill={hex(theme.panel)}
      cornerRadius={16}
      borderColor={hex(theme.panelBorder)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity}
      shadowRadius={22}
      shadowOffset={[0, 8]}
      style={{ position: "absolute", right, top, width: WIDTH, maxHeight }}
    >
      <Header tabId={tabId} boost={boost} />
      <ScrollView style={{ maxHeight: maxHeight - 52 }} contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: PAD }}>
        {session.view === "look" ? <Look tabId={tabId} boost={boost} session={session} /> : <Code tabId={tabId} boost={boost} session={session} />}
      </ScrollView>
    </Surface>
  );
}

function Header({ tabId, boost }: { tabId: string; boost: Boost }) {
  const theme = useTheme();
  const others = useBoosts(useShallow((s) => boostsForHost(s, boost.host)));
  const { hovered, hoverProps } = useHover();
  const menu = async () => {
    const items: MenuItem[] = [];
    if (others.length > 1) {
      for (const b of others) items.push({ id: `boost:${b.id}`, title: b.name, checked: b.id === boost.id });
      items.push({ separator: true });
    }
    items.push(
      { id: "new", title: "New Boost for This Site", symbol: "plus" },
      { id: "rename", title: "Rename Boost…", symbol: "pencil" },
      { id: "shuffle", title: "Shuffle", symbol: "dice" },
      { id: "reset", title: "Reset All Edits…", symbol: "arrow.counterclockwise" },
      { separator: true },
      { id: "import", title: "Import Boost…", symbol: "square.and.arrow.down" },
      { id: "export", title: "Export Boost…", symbol: "square.and.arrow.up" },
      { separator: true },
      { id: "delete", title: "Delete Boost…", symbol: "trash" },
    );
    const choice = await showMenu(items);
    if (!choice) return;
    if (choice.startsWith("boost:")) switchEditorBoost(tabId, choice.slice(6));
    else if (choice === "new") openBoostEditor(tabId, { fresh: true });
    else if (choice === "rename") void renameBoost(tabId, boost.id);
    else if (choice === "shuffle") shuffleBoost(boost.id);
    else if (choice === "reset") void resetBoost(tabId, boost.id);
    else if (choice === "import") void importBoostFile(tabId);
    else if (choice === "export") void exportBoostFile(boost.id);
    else if (choice === "delete") void removeBoost(tabId, boost.id);
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingTop: 8, paddingBottom: 6, gap: 2 }}>
      <IconButton icon="xmark" size={12} box={26} tooltip="Close (Esc)" onPress={() => closeBoostEditor(tabId)} />
      <View {...hoverProps} style={{ flex: 1 }}>
        <Pressable onPress={() => void menu()} accessibilityLabel={`${boost.name}, Boost menu`}>
          <View
            style={{
              height: 26,
              borderRadius: 7,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              backgroundColor: hovered ? theme.toolbarHover : undefined,
            }}
          >
            <Symbol name="paintbrush.pointed.fill" size={11} color={theme.textSecondary} style={{ width: 14, height: 14 }} />
            <Text numberOfLines={1} style={{ maxWidth: 150, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
              {boost.name}
            </Text>
            <Symbol name="chevron.down" size={9} color={theme.textSecondary} style={{ width: 12, height: 12 }} />
          </View>
        </Pressable>
      </View>
      <IconButton icon="dice" size={13} box={26} tooltip="Shuffle" onPress={() => shuffleBoost(boost.id)} />
    </View>
  );
}

// MARK: Look

function Look({ tabId, boost, session }: { tabId: string; boost: Boost; session: EditorSession }) {
  const theme = useTheme();
  const [advanced, setAdvanced] = useState(false);
  const color = boost.color;
  const setColor = (patch: Partial<BoostColor>) => updateBoost(boost.id, (b) => ({ color: { ...(b.color ?? DEFAULT_BOOST_COLOR), ...patch } }));
  const ends = color ? tintEnds(color) : null;
  const sizeIndex = Math.max(
    0,
    BOOST_SIZES.findIndex((s) => Math.abs(s - boost.size) < 0.01),
  );
  const nextSize = () => updateBoost(boost.id, { size: BOOST_SIZES[(sizeIndex + 1) % BOOST_SIZES.length]! });
  const nextCase = () => updateBoost(boost.id, { textCase: BOOST_CASES[(BOOST_CASES.indexOf(boost.textCase) + 1) % BOOST_CASES.length]! });
  const zapping = session.picking === "zap";
  return (
    <View style={{ gap: 10 }}>
      <View style={{ opacity: color ? 1 : 0.55 }}>
        <ColorField
          colors={ends ? [color!.accent, ends.light] : [DEFAULT_BOOST_COLOR.accent]}
          width={FIELD}
          onMoveFirst={(accent) => setColor({ accent, theme: false })}
        />
        <View pointerEvents="box-none" style={{ position: "absolute", bottom: 8, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 4 }}>
          <FieldButton
            icon={boost.invert ? "lightbulb.fill" : "lightbulb"}
            tooltip="Invert"
            on={boost.invert}
            onPress={() => updateBoost(boost.id, { invert: !boost.invert })}
          />
          <FieldButton icon="slider.horizontal.3" tooltip="Advanced Colour Controls" on={advanced} onPress={() => setAdvanced(!advanced)} />
          <FieldButton
            icon="circle.lefthalf.filled"
            tooltip="Second Colour"
            disabled={!color}
            onPress={() => color && setColor({ spread: SPREADS[(SPREADS.indexOf(color.spread) + 1) % SPREADS.length]! })}
          />
          <FieldButton icon="sparkles" tooltip="Space Colours" on={!!color?.theme} onPress={() => setColor({ theme: !color?.theme })} />
          <FieldButton icon="circle.slash" tooltip="Original Colours" disabled={!color} onPress={() => updateBoost(boost.id, { color: null })} />
        </View>
      </View>
      {advanced ? (
        <View style={{ gap: 6 }}>
          <Slider title="Contrast" value={color?.contrast ?? DEFAULT_BOOST_COLOR.contrast} onChange={(contrast) => setColor({ contrast })} />
          <Slider title="Brightness" value={color?.brightness ?? DEFAULT_BOOST_COLOR.brightness} onChange={(brightness) => setColor({ brightness })} />
          <Slider title="Original Saturation" value={color?.saturation ?? DEFAULT_BOOST_COLOR.saturation} onChange={(saturation) => setColor({ saturation })} />
        </View>
      ) : null}

      <Fonts boost={boost} />

      <View style={{ flexDirection: "row", gap: 8 }}>
        <BigButton title="Size" value={`${Math.round(boost.size * 100)}%`} on={boost.size !== 1} onPress={nextSize} flex />
        <BigButton title="Case" value={CASE_TITLES[boost.textCase]} on={boost.textCase !== "none"} onPress={nextCase} flex />
      </View>

      <BigButton
        icon="bolt.fill"
        title={zapping ? "Done Zapping" : "Zap"}
        value={boost.zaps.length ? `${boost.zaps.length}` : undefined}
        on={zapping}
        accent="#FF5F57"
        onPress={() => (zapping ? stopPicking(tabId) : startPicking(tabId, "zap"))}
      />
      {zapping && !boost.zaps.length ? <Hint text="Click elements on the page to zap them. Esc stops." /> : null}
      {boost.zaps.length ? (
        <View style={{ gap: 2 }}>
          {boost.zaps.map((sel) => (
            <ZapRow key={sel} tabId={tabId} boost={boost} selector={sel} count={session.counts[sel]} />
          ))}
        </View>
      ) : null}

      {boost.focus.length ? (
        <BigButton icon="scope" title="Unfocus" value={`${boost.focus.length}`} on onPress={() => updateBoost(boost.id, { focus: [] })} />
      ) : (
        <BigButton
          icon="scope"
          title={session.picking === "focus" ? "Click What to Keep" : "Focus"}
          on={session.picking === "focus"}
          onPress={() => (session.picking === "focus" ? stopPicking(tabId) : startPicking(tabId, "focus"))}
        />
      )}

      <View style={{ height: 0.5, backgroundColor: theme.divider }} />
      <BigButton
        icon="chevron.left.forwardslash.chevron.right"
        title="Code"
        value={boost.css.trim() ? "CSS" : undefined}
        onPress={() => setEditorView(tabId, "code")}
      />
    </View>
  );
}

function Fonts({ boost }: { boost: Boost }) {
  const theme = useTheme();
  const shown = ["", ...BOOST_FONTS.slice(0, 4)];
  const custom = boost.font && !shown.includes(boost.font) ? boost.font : null;
  const more = async () => {
    const families = fontFamilies();
    const items: MenuItem[] = [
      { id: "font:", title: "Site's Font", checked: !boost.font },
      { separator: true },
      ...(families.length ? families : [...BOOST_FONTS]).map((f) => ({ id: `font:${f}`, title: f, checked: boost.font === f })),
    ];
    const choice = await showMenu(items);
    if (choice?.startsWith("font:")) updateBoost(boost.id, { font: choice.slice(5) });
  };
  return (
    <View style={{ flexDirection: "row", gap: 5 }}>
      {shown.map((f) => (
        <FontTile key={f || "site"} font={f} on={boost.font === f} onPress={() => updateBoost(boost.id, { font: f })} />
      ))}
      <View tooltip={custom ?? "More Fonts"} style={{ flex: 1 }}>
        <Tile on={!!custom} onPress={() => void more()}>
          <Symbol name="ellipsis" size={13} color={custom ? "#FFFFFF" : theme.textPrimary} style={{ width: 18, height: 18 }} />
        </Tile>
      </View>
    </View>
  );
}

function FontTile({ font, on, onPress }: { font: string; on: boolean; onPress: () => void }) {
  return (
    <View tooltip={font || "Site's Font"} style={{ flex: 1 }}>
      <Tile on={on} onPress={onPress}>
        {font ? (
          <Text style={{ fontFamily: font, fontSize: 15, color: on ? "#FFFFFF" : undefined }}>Aa</Text>
        ) : (
          <Symbol name="textformat" size={13} color={on ? "#FFFFFF" : undefined} style={{ width: 18, height: 18 }} />
        )}
      </Tile>
    </View>
  );
}

function ZapRow({ tabId, boost, selector, count }: { tabId: string; boost: Boost; selector: string; count: number | undefined }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  // Hovered, its elements show on the page, outlined.
  useEffect(() => {
    if (!hovered) return;
    previewZap(tabId, selector);
    return () => previewZap(tabId, null);
  }, [hovered, tabId, selector]);
  return (
    <View
      {...hoverProps}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 26,
        paddingLeft: 8,
        borderRadius: 7,
        backgroundColor: hovered ? theme.rowHover : undefined,
      }}
    >
      <Text numberOfLines={1} style={{ flex: 1, fontFamily: "Menlo", fontSize: 10.5, color: theme.textSecondary }}>
        {selector}
      </Text>
      {count !== undefined ? <Text style={{ fontSize: 11, color: theme.textTertiary }}>{count}</Text> : null}
      <IconButton
        icon="arrow.uturn.backward"
        size={11}
        box={22}
        tooltip="Unzap"
        onPress={() => {
          previewZap(tabId, null);
          removeSelector(boost.id, "zaps", selector);
        }}
      />
    </View>
  );
}

// MARK: Code

function Code({ tabId, boost, session }: { tabId: string; boost: Boost; session: EditorSession }) {
  const theme = useTheme();
  const script = useBoosts((s) => s.scripts[boost.id]);
  const [dirtyScript, setDirtyScript] = useState(false);
  const toggleScript = async (on: boolean) => {
    if (await toggleBoostScript(tabId, boost.id, boost.host, on)) setDirtyScript(true);
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <IconButton icon="chevron.left" size={12} box={26} tooltip="Back" onPress={() => setEditorView(tabId, "look")} />
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>CSS</Text>
        <IconButton
          icon="scope"
          size={13}
          box={26}
          tooltip={session.picking === "pick" ? "Stop Picking" : "Pick a Selector"}
          color={session.picking === "pick" ? theme.accent : undefined}
          onPress={() => (session.picking === "pick" ? stopPicking(tabId) : startPicking(tabId, "pick"))}
        />
        <IconButton icon="hammer" size={13} box={26} tooltip="Inspect Element" onPress={() => void webviews.get(tabId)?.showDevTools("inspect")} />
      </View>
      <CodeField
        value={boost.css}
        placeholder={"/* Changes show as you type. */\nbody {\n  background: var(--bay-palette-background);\n}"}
        onChange={(css) => updateBoost(boost.id, { css })}
      />
      <Hint text="Your space's colours: var(--bay-palette-background), --bay-palette-foreground, --bay-palette-accent and --bay-palette-color0…" />

      <View style={{ height: 0.5, backgroundColor: theme.divider, marginVertical: 4 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>JavaScript</Text>
        <Toggle value={!!script?.enabled} onChange={(on) => void toggleScript(on)} />
      </View>
      <Hint text="Only on this Mac, and never synced. It runs once each page's content has loaded, in its own world beside the page's scripts." />
      <CodeField
        value={script?.code ?? ""}
        placeholder={'document.querySelectorAll("video").forEach((v) => (v.playbackRate = 1.5));'}
        onChange={(code) => {
          setBoostScript(boost.id, { code });
          if (script?.enabled) setDirtyScript(true);
        }}
      />
      {script?.enabled ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>Run in private windows</Text>
          <Toggle value={script.privateWindows} onChange={(privateWindows) => setBoostScript(boost.id, { privateWindows })} />
        </View>
      ) : null}
      {dirtyScript ? (
        <BigButton
          icon="arrow.clockwise"
          title="Reload to Run"
          onPress={() => {
            setDirtyScript(false);
            void webviews.get(tabId)?.reload();
          }}
        />
      ) : null}
    </View>
  );
}

function CodeField({ value, placeholder, onChange }: { value: string; placeholder: string; onChange(v: string): void }) {
  const theme = useTheme();
  return (
    <TextInput
      multiline
      value={value}
      placeholder={placeholder}
      placeholderTextColor={theme.textTertiary}
      onChangeText={onChange}
      autoCorrect={false}
      spellCheck={false}
      style={{
        minHeight: 150,
        maxHeight: 280,
        padding: 8,
        borderRadius: 8,
        fontFamily: "Menlo",
        fontSize: 11,
        lineHeight: 15,
        color: theme.textPrimary,
        backgroundColor: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
      }}
    />
  );
}

// MARK: Controls

function Hint({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={{ fontSize: 11, lineHeight: 14.5, color: theme.textSecondary }}>{text}</Text>;
}

function FieldButton({ icon, tooltip, on, disabled, onPress }: { icon: string; tooltip: string; on?: boolean; disabled?: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View tooltip={tooltip} {...hoverProps}>
      <Pressable onPress={onPress} disabled={disabled} accessibilityLabel={tooltip}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            opacity: disabled ? 0.4 : 1,
            backgroundColor: on ? theme.textPrimary : hovered ? (theme.dark ? "#3A3A3C" : "#FFFFFF") : theme.dark ? "#2A2A2CE6" : "#FFFFFFE6",
          }}
        >
          <Symbol name={icon} size={12} color={on ? (theme.dark ? "#000000" : "#FFFFFF") : theme.textPrimary} style={{ width: 16, height: 16 }} />
        </View>
      </Pressable>
    </View>
  );
}

function Tile({ on, onPress, children }: { on: boolean; onPress: () => void; children: ReactNode }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View
          style={{
            height: 36,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: on ? "#3478F6" : hovered ? theme.toolbarPressed : theme.toolbarHover,
          }}
        >
          {children}
        </View>
      </Pressable>
    </View>
  );
}

function BigButton({
  icon,
  title,
  value,
  on,
  accent = "#3478F6",
  flex,
  onPress,
}: {
  icon?: string;
  title: string;
  value?: string;
  on?: boolean;
  accent?: string;
  flex?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const tint = on ? "#FFFFFF" : theme.textPrimary;
  return (
    <View {...hoverProps} style={flex ? { flex: 1 } : undefined}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
        {({ pressed }) => (
          <View
            style={{
              height: 38,
              borderRadius: 10,
              paddingHorizontal: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: on ? accent : pressed || hovered ? theme.toolbarPressed : theme.toolbarHover,
            }}
          >
            {icon ? <Symbol name={icon} size={12} color={tint} style={{ width: 16, height: 16 }} /> : null}
            <Text style={{ flex: 1, fontSize: 13, fontWeight: "500", color: tint }}>{title}</Text>
            {value ? <Text style={{ fontSize: 12, fontWeight: "600", color: on ? "#FFFFFFCC" : theme.textSecondary }}>{value}</Text> : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function Slider({ title, value, onChange }: { title: string; value: number; onChange(v: number): void }) {
  const theme = useTheme();
  const track = useRef<View>(null);
  const origin = useRef({ x: 0, width: 1 });
  const change = useEffectEvent((e: GestureResponderEvent) =>
    onChange(Math.min(1, Math.max(0, (e.nativeEvent.pageX - origin.current.x) / Math.max(1, origin.current.width)))),
  );
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => change(e),
      onPanResponderMove: (e) => change(e),
      onPanResponderTerminationRequest: () => false,
    }),
  );
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row" }}>
        <Text style={{ flex: 1, fontSize: 11.5, color: theme.textSecondary }}>{title}</Text>
        <Text style={{ fontSize: 11.5, color: theme.textTertiary }}>{Math.round(value * 100)}</Text>
      </View>
      <View
        ref={track}
        {...pan.panHandlers}
        onLayout={() => track.current?.measureInWindow((x, _y, width) => (origin.current = { x, width }))}
        style={{ height: 16, justifyContent: "center" }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.toolbarPressed }}>
          <View style={{ width: `${value * 100}%`, height: 4, borderRadius: 2, backgroundColor: "#3478F6" }} />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: `${value * 100}%`,
            marginLeft: -7,
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: "#FFFFFF",
            borderWidth: 0.5,
            borderColor: "#00000040",
          }}
        />
      </View>
    </View>
  );
}
