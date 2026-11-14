import { reportBrowserCommand } from "../../runtime/commands";
import * as tabCommands from "../../runtime/tabActions";
import { Pressable, View } from "@bay/platform";
import * as v from "valibot";
import { FadeLabel, Symbol } from "@bay/desktop";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { useIsSleeping } from "../../lib/tabLifecycle";
import { ago } from "../../activity/meetings";
import { useBrowserRead as useBrowser } from "../../store/read";
import { HoverSurface, SmallButton } from "../activity/LiveItemCard";
import { useHover } from "../ui/primitives";
import { dismissHover } from "../sidebar/hover";
import { runWindow } from "../../effect/windowRuntime";
import { PreviewService, type SitePreview } from "../site/previewService";
import type { Anchor } from "../sidebar/state";
import { gmailAccount, previewSiteOf, type GithubData, type GmailData, type PreviewSite, type Pull, type Review } from "./knownSites";

const FRESH_MS = 60_000;
const ROWS = 5;

type Answer<T> = { kind: "ready"; data: T } | { kind: "signedOut" } | { kind: "unloaded" } | { kind: "unreadable" };

type State<T> = Answer<T> | { kind: "loading" };

// The last answer per tab: shown at once on the next hover while a fresh one comes, never older than a minute unasked.
const answers = new Map<string, { at: number; answer: Answer<GmailData | GithubData> }>();

/** A test's data for a tab, as if its site had answered (lib/devHarness.ts). */
export function primePreview(tabId: string, data: GmailData | GithubData) {
  answers.set(tabId, { at: Date.now(), answer: { kind: "ready", data } });
}

/** The preview a tab shows on hover, if any: a pinned or favorite tab on a known site, with its preview turned on. */
export function useSitePreview(tabId: string | undefined): PreviewSite | null {
  return useBrowser((s) => {
    const site = tabId ? previewSiteOf(s.tabs[tabId]) : null;

    if (site === "gmail" && s.settings.previewGmail) return site;

    if (site === "github" && s.settings.previewGithub) return site;

    return null;
  });
}

async function ask(tabId: string, site: PreviewSite): Promise<SitePreview> {
  return runWindow(
    Effect.gen(function* () {
      const preview = yield* PreviewService;

      return yield* preview.site(tabId, site);
    }),
  );
}

function usePreviewData<T>(tabId: string, site: PreviewSite): State<T> {
  const sleeping = useIsSleeping(tabId);
  const cached = answers.get(tabId);
  // SAFETY: Answer<T>) assertion matches the runtime value validated at this call site.
  const [state, setState] = useState<State<T>>(() => (cached ? (cached.answer as Answer<T>) : { kind: "loading" }));
  useEffect(() => {
    if (sleeping) return setState({ kind: "unloaded" });

    if (cached && Date.now() - cached.at < FRESH_MS) return;
    let live = true;
    void ask(tabId, site).then((answer) => {
      // A newer preview for the same tab came in while this one was out: its answer is the one that counts.
      if (answer.kind === "stale") return;

      answers.set(tabId, { at: Date.now(), answer });

      if (live) {
        // SAFETY: ask resolves with the site's validated Answer<T> for this tab; the cache stores the same value.
        setState(answer as Answer<T>);
      }
    });

    return () => {
      live = false;
    };
  }, [tabId, site, sleeping]);

  return state;
}

// An item opens in its pinned tab, as Arc's previews do.
function openInTab(tabId: string, url: string) {
  dismissHover();
  reportBrowserCommand(tabCommands.activate(tabId));

  if (url) reportBrowserCommand(tabCommands.navigate(tabId, url));
}

export function SitePreview({ tabId, site, anchor }: { tabId: string; site: PreviewSite; anchor: Anchor }) {
  return site === "gmail" ? <GmailPreview tabId={tabId} anchor={anchor} /> : <GithubPreview tabId={tabId} anchor={anchor} />;
}

function GmailPreview({ tabId, anchor }: { tabId: string; anchor: Anchor }) {
  const state = usePreviewData<GmailData>(tabId, "gmail");
  const account = useBrowser((s) => gmailAccount(s.tabs[tabId]?.url ?? ""));
  const now = Date.now();
  const count = state.kind === "ready" ? (state.data.unread ? `${state.data.unread} unread` : "") : "";

  return (
    <HoverSurface anchor={anchor} width={300}>
      <Header title="Inbox" detail={count}>
        <SmallButton
          title="Compose"
          icon="square.and.pencil"
          onPress={() => openInTab(tabId, `https://mail.google.com/mail/u/${account}/#inbox?compose=new`)}
        />
      </Header>
      <Body state={state} tabId={tabId} name="Gmail" what="your unread mail" empty="No unread mail" isEmpty={(data) => !data.mails.length}>
        {(data) =>
          data.mails
            .slice(0, ROWS)
            .map((m, i) => (
              <ItemRow
                key={`${m.url}${i}`}
                title={m.from || "(no sender)"}
                detail={m.subject || "(no subject)"}
                trailing={m.at ? ago(m.at, now) : ""}
                onPress={() => openInTab(tabId, m.url)}
              />
            ))
        }
      </Body>
    </HoverSurface>
  );
}

function GithubPreview({ tabId, anchor }: { tabId: string; anchor: Anchor }) {
  const state = usePreviewData<GithubData>(tabId, "github");

  return (
    <HoverSurface anchor={anchor} width={320}>
      <Header title="Pull requests" detail={state.kind === "ready" ? `${state.data.authored.length} open` : ""} />
      <Body
        state={state}
        tabId={tabId}
        name="GitHub"
        what="your pull requests"
        empty="No open pull requests"
        isEmpty={(data) => !data.authored.length && !data.requested.length}
      >
        {(data) => (
          <>
            {data.authored.slice(0, ROWS).map((p) => (
              <PullRow key={p.url} pull={p} tabId={tabId} />
            ))}
            {data.requested.length ? <SectionTitle title="Review requested" /> : null}
            {data.requested.slice(0, ROWS).map((p) => (
              <PullRow key={p.url} pull={p} tabId={tabId} />
            ))}
          </>
        )}
      </Body>
    </HoverSurface>
  );
}

// GitHub's own marks: green for approved, red for changes requested, a dashed ring while a review is wanted.
const REVIEWS: Record<Review, { label: string; icon: string; tint: string | null }> = {
  approved: { label: "Approved", icon: "checkmark.circle.fill", tint: "#2DA44E" },
  changes: { label: "Changes requested", icon: "exclamationmark.circle.fill", tint: "#CF222E" },
  required: { label: "Review required", icon: "circle.dashed", tint: null },
};

function PullRow({ pull, tabId }: { pull: Pull; tabId: string }) {
  const theme = useTheme();
  const review = pull.review ? REVIEWS[pull.review] : null;

  return (
    <ItemRow
      title={pull.title}
      detail={`${pull.repo} #${pull.number}`}
      trailing={
        review ? (
          <View tooltip={review.label}>
            <Symbol name={review.icon} size={12} color={review.tint ?? theme.textTertiary} style={{ width: 16, height: 16 }} />
          </View>
        ) : null
      }
      onPress={() => openInTab(tabId, pull.url)}
    />
  );
}

function Header({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) {
  const theme = useTheme();

  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6, marginTop: -2, minHeight: 24 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>{title}</Text>
      {detail ? <Text style={{ marginLeft: 6, fontSize: 12, color: theme.textSecondary }}>{detail}</Text> : null}
      <View style={{ flex: 1 }} />
      {children}
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  const theme = useTheme();

  return <Text style={{ fontSize: 11.5, fontWeight: "600", color: theme.textSecondary, marginTop: 8, marginBottom: 2, marginLeft: 4 }}>{title}</Text>;
}

// What a preview says when it has nothing to list: still loading, signed out, the tab not loaded, or none.
function Body<T>({
  state,
  tabId,
  name,
  what,
  empty,
  isEmpty,
  children,
}: {
  state: State<T>;
  tabId: string;
  name: string;
  what: string;
  empty: string;
  isEmpty(data: T): boolean;
  children(data: T): React.ReactNode;
}) {
  if (state.kind === "loading") return <Note text="Loading…" />;

  if (state.kind === "signedOut")
    return <Note text={`Sign in to ${name} in this tab to see ${what} here.`} action={`Open ${name}`} onPress={() => openInTab(tabId, "")} />;

  if (state.kind === "unloaded") return <Note text={`Open ${name} once to see ${what} here.`} action={`Open ${name}`} onPress={() => openInTab(tabId, "")} />;

  if (state.kind === "unreadable")
    return <Note text={`${name} didn't answer. Open it to see ${what}.`} action={`Open ${name}`} onPress={() => openInTab(tabId, "")} />;

  return isEmpty(state.data) ? <Note text={empty} /> : <View style={{ gap: 1 }}>{children(state.data)}</View>;
}

function Note({ text, action, onPress }: { text: string; action?: string; onPress?(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();

  return (
    <View {...hoverProps} style={{ paddingVertical: 4 }}>
      <Text style={{ fontSize: 12.5, lineHeight: 17, color: theme.textSecondary }}>
        {text}
        {action && onPress ? (
          <Text onPress={onPress} style={{ color: theme.accent, textDecorationLine: hovered ? "underline" : "none" }}>
            {" "}
            {action}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

function ItemRow({ title, detail, trailing, onPress }: { title: string; detail: string; trailing: React.ReactNode; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();

  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 5,
            paddingHorizontal: 4,
            borderRadius: 8,
            backgroundColor: hovered ? theme.rowHover : undefined,
          }}
        >
          <View style={{ flex: 1, gap: 1 }}>
            <FadeLabel text={title} fontSize={12.5} weight="medium" color={theme.textPrimary} style={{ height: 16 }} />
            <FadeLabel text={detail} fontSize={11.5} color={theme.textSecondary} style={{ height: 15 }} />
          </View>
          {v.is(v.string(), trailing) ? <Text style={{ fontSize: 11, color: theme.textTertiary }}>{trailing}</Text> : trailing}
        </View>
      </Pressable>
    </View>
  );
}
