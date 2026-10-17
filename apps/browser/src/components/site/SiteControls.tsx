import { ScrollView } from "@bay/platform";
import { Pressable, View } from "@bay/platform";
import {
  getContentBlocker,
  getSiteSettings,
  isContentBlockerAllowed,
  setContentBlockerAllowed,
  setSiteSetting,
  type SecurityInfo,
  type SiteSettingType,
  type SiteSettingValue,
  type SiteSettings,
  type InstalledExtension,
  type ActionState,
} from "@bay/nncore";
import { cleanUrl, displayHost, markdownLink } from "@bay/core";
import { confirm, copyText, sharePage, showMenu, Symbol, translation, type MenuItem } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { webviews } from "../../lib/webviews";
import { useBrowser } from "../../store/browser";
import { useIsBookmarked, useSettings, useTab } from "../../store/hooks";
import { bookmarkProfileId, engineProfile, tabLabel } from "../../store/model";
import { Favicon, useHover } from "../primitives";
import { Popover, PopoverRow, PopoverSeparator, Toggle } from "../layout/controls";
import { toggleDeveloperMode } from "../developer/devMode";
import { useIsDeveloperTab } from "../developer/sites";
import { patchPage, setPopover, usePage, usePages } from "../layout/pageState";
import { showToast } from "../layout/splitActions";
import { toggleCastPicker } from "../media/cast";
import { useMedia, usePictureInPicture } from "../media/state";
import { TranslateRows } from "./TranslateControls";
import { ZoomStepper } from "./ZoomControls";
import { activateExtension, loadUnpacked, openManageExtensions, openWebStore, useExtensions, useWindowExtensions, type Anchor } from "../extensions/state";
import { defaultTarget, languageName, toggleTranslation, useTranslateState } from "./translate";

const PERMISSIONS: { type: SiteSettingType; title: string; icon: string; choices: SiteSettingValue[] }[] = [
  { type: "popups", title: "Pop-ups and Redirects", icon: "macwindow.on.rectangle", choices: ["allow", "block"] },
  { type: "camera", title: "Camera", icon: "video", choices: ["ask", "allow", "block"] },
  { type: "microphone", title: "Microphone", icon: "mic", choices: ["ask", "allow", "block"] },
  { type: "location", title: "Location", icon: "location", choices: ["ask", "allow", "block"] },
  { type: "notifications", title: "Notifications", icon: "bell", choices: ["ask", "allow", "block"] },
  { type: "sound", title: "Sound", icon: "speaker.wave.2", choices: ["allow", "block"] },
];

const choiceTitle = (type: SiteSettingType, value: SiteSettingValue) =>
  type === "sound" ? (value === "block" ? "Muted" : "Allowed") : value === "allow" ? "Allowed" : value === "block" ? "Blocked" : "Ask";

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function SiteControls({ tabId, right, left, top, width = 306, maxHeight = 580, arrowLeft }: {
  tabId: string;
  right?: number;
  left?: number;
  top: number;
  width?: number;
  maxHeight?: number;
  arrowLeft?: number;
}) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const security = usePage(tabId, (p) => p.security);
  const blocked = usePage(tabId, (p) => p.blocked);
  const showFullUrl = useSettings((s) => s.showFullUrl);
  const developer = useIsDeveloperTab(tabId);
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [blocker, setBlocker] = useState<{ enabled: boolean; allowed: boolean } | null>(null);
  const [certOpen, setCertOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const url = tab?.url ?? "";
  const bookmarked = useIsBookmarked(url);
  const extensions = useWindowExtensions(tab?.windowId ?? "");
  const translate = useTranslateState(tabId);
  const browserId = usePages((p) => {
    for (const [id, page] of Object.entries(p.browsers)) if (page === tabId) return Number(id);
    return 0;
  });
  const actions = useExtensions((e) => e.actions[browserId]);
  const origin = originOf(url);
  const host = origin ? new URL(origin).hostname : "";
  const profile = engineProfile(tab?.profileId ?? "");
  const close = () => setPopover(tabId, null);
  // Document PiP may have a window without a tab session.
  const video = useMedia((m) => !!m.sessions[tabId]?.hasVideo || !!m.pipOpen[tabId]);
  const [pip, togglePip] = usePictureInPicture(tabId);

  useEffect(() => {
    if (!origin) return;
    let live = true;
    void getSiteSettings(profile, origin).then((s) => live && setSettings(s));
    void Promise.all([getContentBlocker(), isContentBlockerAllowed(host)]).then(([state, allowed]) => live && setBlocker({ enabled: state.enabled, allowed }));
    // Navigation may finish before the popover subscribes to security updates.
    void webviews.get(tabId)?.getSecurityInfo().then((info) => live && info && patchPage(tabId, { security: info }));
    return () => {
      live = false;
    };
  }, [origin, profile, host, tabId]);

  if (!tab) return null;

  const setPermission = async (type: SiteSettingType, value: SiteSettingValue) => {
    if (!origin) return;
    await setSiteSetting(profile, origin, type, value);
    setSettings(await getSiteSettings(profile, origin));
    if (type === "sound") {
      useBrowser.getState().updateTab(tabId, { muted: value === "block" });
      void webviews.get(tabId)?.setMuted(value === "block");
    }
  };
  const pickPermission = async (type: SiteSettingType, choices: SiteSettingValue[]) => {
    const current = settings?.[type]?.value;
    const choice = await showMenu(choices.map((v) => ({ id: v, title: choiceTitle(type, v), checked: v === current })));
    if (choice) void setPermission(type, choice as SiteSettingValue);
  };
  const toggleBlocker = async (on: boolean) => {
    // A change that fails changed nothing: the toggle shows what the blocker has, and the window says so.
    const failed = await setContentBlockerAllowed(host, !on).then(() => false, () => true);
    const allowed = await isContentBlockerAllowed(host);
    setBlocker((b) => (b ? { ...b, allowed } : b));
    if (failed) return showToast(tab.windowId, "Couldn't Change the Ad Blocker", `Blocking on ${host} is as it was. Try again.`, { icon: "exclamationmark.triangle" });
    // Reload: blocking changes affect new requests only.
    void webviews.get(tabId)?.reload();
  };
  const clearData = async () => {
    if (!origin) return;
    const { confirmed } = await confirm({
      title: `Clear cookies and site data for ${host}?`,
      message: "You'll be signed out of this site, and its offline data will be deleted.",
      confirmTitle: "Clear",
      destructive: true,
      windowId: tab.windowId,
    });
    if (!confirmed) return;
    const result = await webviews.get(tabId)?.clearSiteData();
    const n = result && typeof result.cookies === "number" ? result.cookies : 0;
    setCleared(n ? `Cleared ${n} cookie${n === 1 ? "" : "s"} and site data` : "Cleared site data");
    void webviews.get(tabId)?.reload();
  };
  const copyClean = () => {
    copyText(cleanUrl(url));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const more = async () => {
    const items: MenuItem[] = [];
    if (origin) items.push({ id: "clear", title: `Clear Cookies and Data for ${displayHost(host)}…`, symbol: "trash" });
    if (origin && translation && (translate.source || translate.status !== "idle")) {
      items.push({ id: "translate", title: translate.status !== "idle" ? "Show Original" : `Translate to ${languageName(defaultTarget())}`, symbol: "translate" });
    }
    items.push(
      { id: "markdown", title: "Copy Markdown Link", symbol: "link" },
      { separator: true },
      { id: "manage", title: "Manage Extensions…" },
      { id: "store", title: "Chrome Web Store…" },
      { id: "unpacked", title: "Load Unpacked…" },
      { separator: true },
      { id: "settings", title: "All Site Settings…", checked: detailsOpen },
    );
    const choice = await showMenu(items);
    if (choice === "clear") void clearData();
    else if (choice === "translate") {
      close();
      toggleTranslation(tabId);
    } else if (choice === "markdown") {
      copyText(markdownLink(tab.customTitle || tab.title, url));
      showToast(tab.windowId, "Copied Markdown Link", undefined, { icon: "link" });
    } else if (choice === "manage" || choice === "store" || choice === "unpacked") {
      close();
      if (choice === "manage") openManageExtensions();
      else if (choice === "store") openWebStore(tab.windowId);
      else void loadUnpacked(tab.windowId);
    } else if (choice === "settings") setDetailsOpen((open) => !open);
  };
  const secure = security?.level === "secure";
  const local = !security || security.level === "none" || security.level === "local";

  return (
    <Popover width={width} top={top} right={right} left={left} onDismiss={close}>
      {arrowLeft !== undefined ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -6,
            left: Math.max(16, Math.min(width - 28, arrowLeft - 6)),
            width: 12,
            height: 12,
            transform: [{ rotate: "45deg" }],
            backgroundColor: theme.dark ? "#262425" : "#FCFBFC",
            borderTopWidth: 0.5,
            borderLeftWidth: 0.5,
            borderColor: theme.dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)",
          }}
        />
      ) : null}
      <ScrollView style={{ maxHeight: Math.max(0, maxHeight - 55) }} contentContainerStyle={{ paddingTop: 10, paddingBottom: 5 }}>
        {!detailsOpen ? (
          <>
            <View style={{ flexDirection: "row", gap: 7, paddingHorizontal: 10 }}>
              <ActionTile
                icon="square.and.arrow.up"
                title="Share Page"
                disabled={!origin}
                onPress={() => {
                  close();
                  void sharePage(url, tab.customTitle || tab.title, tab.windowId);
                }}
              />
              <ActionTile icon={copied ? "checkmark" : "link"} title={copied ? "Copied Clean Link" : "Copy Clean Link"} onPress={copyClean} />
              <ActionTile
                icon={bookmarked ? "star.fill" : "star"}
                title={bookmarked ? "Remove Bookmark" : "Bookmark Page"}
                onPress={() => {
                  const s = useBrowser.getState();
                  s.toggleBookmark(bookmarkProfileId(s, s.windows[tab.windowId]), tab);
                }}
              />
              <ActionTile icon="plus.magnifyingglass" title="Zoom and Site Settings" onPress={() => setDetailsOpen((open) => !open)} />
            </View>

            <View style={{ paddingHorizontal: 14, paddingTop: 17, paddingBottom: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>Extensions</Text>
              <Pressable
                onPress={() => {
                  close();
                  openManageExtensions();
                }}
              >
                <Text style={{ fontSize: 12, color: theme.textSecondary }}>Manage</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, paddingHorizontal: 10 }}>
              {extensions.map((ext) => (
                <ExtensionTile key={ext.id} ext={ext} state={actions?.[ext.id]} windowId={tab.windowId} width={(width - 48) / 5} onClose={close} />
              ))}
              <ActionTile
                icon="plus"
                title="Add Extension"
                width={(width - 48) / 5}
                onPress={() => {
                  close();
                  openWebStore(tab.windowId);
                }}
              />
            </View>

            {origin ? (
              <>
                <Text style={{ paddingHorizontal: 14, paddingTop: 17, paddingBottom: 5, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
                  This site
                </Text>
                <PopoverRow
                  icon="shield.lefthalf.filled"
                  title="Block ads and trackers"
                  detail={!blocker ? "Loading…" : !blocker.enabled ? "Off in Settings" : blocker.allowed ? "Off" : blocked > 0 ? `On · ${blocked} blocked` : "On"}
                  accessory={blocker?.enabled ? <Toggle value={!blocker.allowed} onChange={(on) => void toggleBlocker(on)} /> : null}
                />
                <PopoverRow
                  icon="chevron.left.forwardslash.chevron.right"
                  title="Developer Mode"
                  detail={developer ? "Address, inspector and DevTools over the page" : undefined}
                  accessory={<Toggle value={developer} onChange={() => toggleDeveloperMode(tabId)} />}
                />
              </>
            ) : null}
          </>
        ) : null}
        {cleared ? (
          <Text style={{ paddingHorizontal: 14, paddingTop: 5, fontSize: 11, color: theme.textSecondary }}>{cleared}</Text>
        ) : null}
        {certOpen ? <ConnectionRow security={security} open={certOpen} onToggle={() => setCertOpen(false)} /> : null}
        {certOpen && security?.certificate ? <CertificateDetails security={security} /> : null}

        {detailsOpen ? (
          <>
            <PopoverRow icon="chevron.left" title="Site controls" onPress={() => setDetailsOpen(false)} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, paddingTop: 6, paddingBottom: 8 }}>
              <Favicon url={url} favicon={tab.favicon} size={20} profileId={tab.profileId} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
                  {host ? displayHost(host) : tabLabel(tab)}
                </Text>
                {tab.title ? (
                  <Text numberOfLines={1} style={{ fontSize: 11, color: theme.textSecondary }}>
                    {tab.title}
                  </Text>
                ) : null}
              </View>
            </View>

            <ZoomRow tabId={tabId} zoom={tab.zoom} />
            <PopoverSeparator />

            {video ? (
              <PopoverRow
                icon={pip ? "pip.exit" : "pip.enter"}
                title={pip ? "Exit Picture in Picture" : "Picture in Picture"}
                onPress={() => {
                  togglePip();
                  close();
                }}
              />
            ) : null}
            {origin ? (
              <PopoverRow
                icon="tv.and.mediabox"
                title="Cast…"
                onPress={() => {
                  close();
                  if (tab) void toggleCastPicker(tab.windowId);
                }}
              />
            ) : null}
            {video || origin ? <PopoverSeparator /> : null}
            {origin ? <TranslateRows tabId={tabId} onClose={close} /> : null}

            {origin && (
              <>
                {PERMISSIONS.map((p) => (
                  <PopoverRow
                    key={p.type}
                    icon={p.icon}
                    title={p.title}
                    accessory={<ValueButton title={settings ? choiceTitle(p.type, settings[p.type]?.value ?? "ask") : "…"} onPress={() => void pickPermission(p.type, p.choices)} />}
                  />
                ))}
              </>
            )}
            <PopoverRow
              icon="text.alignleft"
              title="Show Full URL"
              accessory={<Toggle value={showFullUrl} onChange={(v) => useBrowser.getState().updateSettings({ showFullUrl: v })} />}
            />
          </>
        ) : null}
      </ScrollView>
      <PopoverSeparator />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, paddingBottom: 10 }}>
        <Pressable onPress={() => setCertOpen((open) => !open)} accessibilityLabel="Connection security details">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, height: 30, borderRadius: 10, backgroundColor: theme.toolbarHover }}>
            <Symbol
              name={secure ? "lock" : local ? "info.circle" : "lock.open.trianglebadge.exclamationmark"}
              size={12}
              color={secure || local ? theme.textPrimary : "#FF6B63"}
              style={{ width: 14, height: 16 }}
            />
            <Text style={{ fontSize: 12, fontWeight: "500", color: theme.textPrimary }}>
              {secure ? "Secure" : local ? "Local Page" : "Not Secure"}
            </Text>
          </View>
        </Pressable>
        <View tooltip="More Site Controls">
          <Pressable onPress={() => void more()} accessibilityLabel="More site controls">
            <View style={{ width: 32, height: 30, alignItems: "center", justifyContent: "center" }}>
              <Symbol name="ellipsis" size={17} color={theme.textSecondary} style={{ width: 23, height: 20 }} />
            </View>
          </Pressable>
        </View>
      </View>
    </Popover>
  );
}

function ActionTile({ icon, title, onPress, disabled, width, children }: { icon?: string; title: string; onPress: () => void; disabled?: boolean; width?: number; children?: ReactNode }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View tooltip={title} {...hoverProps} style={width === undefined ? { flex: 1 } : { width }}>
      <Pressable onPress={onPress} disabled={disabled} accessibilityLabel={title} accessibilityRole="button">
        {({ pressed }) => (
          <View
            style={{
              height: 40,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              opacity: disabled ? 0.4 : 1,
              backgroundColor: pressed ? theme.toolbarPressed : hovered ? theme.toolbarHover : theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
            }}
          >
            {children ?? <Symbol name={icon!} size={18} color={theme.textPrimary} style={{ width: 24, height: 24 }} />}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function ExtensionTile({ ext, state, windowId, width, onClose }: { ext: InstalledExtension; state?: ActionState; windowId: string; width: number; onClose: () => void }) {
  const theme = useTheme();
  const ref = useRef<View>(null);
  const icon = state?.icon || ext.actionIcon || ext.icon;
  const open = () => {
    ref.current?.measureInWindow((x, y, measuredWidth, height) => {
      const anchor: Anchor = { x, y, width: measuredWidth, height };
      onClose();
      void activateExtension(windowId, ext, anchor, state);
    });
  };
  return (
    <View ref={ref} style={{ width }}>
      <ActionTile title={state?.title || ext.actionTitle || ext.name} width={width} onPress={open}>
        {icon ? (
          <Image source={{ uri: icon }} style={{ width: 22, height: 22, opacity: state && !state.enabled ? 0.45 : 1 }} />
        ) : (
          <Symbol name="puzzlepiece.extension" size={18} color={theme.textPrimary} style={{ width: 24, height: 24 }} />
        )}
        {state?.badgeText ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", bottom: 3, right: 3, paddingHorizontal: 3, borderRadius: 3, backgroundColor: state.badgeColor || "#5F6368" }}
          >
            <Text numberOfLines={1} style={{ fontSize: 8, fontWeight: "600", color: state.badgeTextColor || "#FFFFFF" }}>
              {state.badgeText.slice(0, 4)}
            </Text>
          </View>
        ) : null}
      </ActionTile>
    </View>
  );
}

function ConnectionRow({ security, open, onToggle }: { security: SecurityInfo | null; open: boolean; onToggle: () => void }) {
  const theme = useTheme();
  const level = security?.level ?? "none";
  const secure = level === "secure";
  const local = level === "local" || level === "none";
  const title = secure ? "Connection is secure" : local ? "This is a local or internal page" : "Connection is not secure";
  const detail =
    level === "certificateError"
      ? "The site's certificate isn't valid. Don't enter passwords or payment details."
      : level === "mixed"
        ? "Parts of this page aren't secure (such as images)."
        : level === "insecure"
          ? "Don't enter sensitive information on this site."
          : secure && security?.certificate
            ? `Certificate issued by ${security.certificate.issuer.organizations[0] || security.certificate.issuer.commonName}`
            : undefined;
  return (
    <PopoverRow
      icon={secure ? "lock.fill" : local ? "info.circle" : "lock.open.trianglebadge.exclamationmark.fill"}
      iconColor={level === "certificateError" || level === "insecure" ? "#FF6B63" : level === "mixed" ? "#F2B33D" : theme.icon}
      title={title}
      detail={detail}
      onPress={security?.certificate ? onToggle : undefined}
      accessory={security?.certificate ? <Symbol name={open ? "chevron.up" : "chevron.down"} size={10} color={theme.textSecondary} style={{ width: 14, height: 14 }} /> : null}
    />
  );
}

function CertificateDetails({ security }: { security: SecurityInfo }) {
  const theme = useTheme();
  const cert = security.certificate!;
  const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const rows: [string, string][] = [
    ["Issued to", cert.subject.commonName || cert.subject.displayName],
    ["Organization", cert.subject.organizations.join(", ") || "—"],
    ["Issued by", cert.issuer.commonName || cert.issuer.displayName],
    ["Valid from", date(cert.validFrom)],
    ["Expires", date(cert.validUntil)],
    ...(security.protocol ? [["Protocol", security.protocol] as [string, string]] : []),
    ...(cert.sha256 ? [["SHA-256", cert.sha256.replace(/(.{2})(?!$)/g, "$1 ").slice(0, 47) + "…"] as [string, string]] : []),
  ];
  return (
    <View style={{ marginHorizontal: 13, marginTop: 2, marginBottom: 4, padding: 9, borderRadius: 8, backgroundColor: theme.dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)", gap: 3 }}>
      {rows.map(([k, v]) => (
        <View key={k} style={{ flexDirection: "row", gap: 8 }}>
          <Text style={{ width: 82, fontSize: 11, color: theme.textSecondary }}>{k}</Text>
          <Text numberOfLines={2} selectable style={{ flex: 1, fontSize: 11, color: theme.textPrimary }}>
            {v}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ZoomRow({ tabId, zoom }: { tabId: string; zoom: number }) {
  return <PopoverRow icon="plus.magnifyingglass" title="Zoom" accessory={<ZoomStepper tabId={tabId} zoom={zoom} />} />;
}

function ValueButton({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 22, paddingLeft: 8, paddingRight: 5, borderRadius: 6, backgroundColor: hovered ? theme.toolbarHover : undefined }}>
          <Text style={{ fontSize: 12, color: theme.textSecondary }}>{title}</Text>
          <Symbol name="chevron.up.chevron.down" size={9} color={theme.textSecondary} style={{ width: 12, height: 14 }} />
        </View>
      </Pressable>
    </View>
  );
}
