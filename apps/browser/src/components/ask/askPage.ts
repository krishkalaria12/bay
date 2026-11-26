import { askPageModel } from "@bay/desktop";
import * as v from "valibot";
import { create } from "zustand";
import { webviews } from "../../lib/webviews";
import { browserRead } from "../../store/read";

// Ask on Page: a question about the page in front of the person, answered by the Mac's on-device model from the page's
// title, address and text (packages/desktop/ios/AskPageModule.swift). Nothing leaves the Mac. Hidden where Apple
// Intelligence isn't on, and on Windows and Linux.

export type AskState = { open: boolean; question: string; answer: string | null; asking: boolean; failed: boolean };

const CLOSED: AskState = { open: false, question: "", answer: null, asking: false, failed: false };

export const useAskPage = create<Record<string, AskState | undefined>>()(() => ({}));

export const askStateOf = (tabId: string) => useAskPage.getState()[tabId] ?? CLOSED;

const patch = (tabId: string, next: Partial<AskState>) => useAskPage.setState({ [tabId]: { ...askStateOf(tabId), ...next } });

/** Whether this Mac can answer questions about pages now. */
export const canAskPage = () => askPageModel?.status() === "available";

export const openAskPage = (tabId: string) => patch(tabId, { open: true });

export const closeAskPage = (tabId: string) => useAskPage.setState({ [tabId]: CLOSED });

// The page's own words, as it shows them; scripts and hidden text left out by innerText.
const READ_TEXT = "(() => { try { return (document.body && document.body.innerText || '').slice(0, 20000); } catch { return ''; } })()";

/** Asks the model about the tab's page; the answer lands in the tab's state, unless the question changed meanwhile. */
export async function askAboutPage(tabId: string, question: string) {
  const tab = browserRead.getState().tabs[tabId];
  const asked = question.trim();

  if (!tab || !asked || !askPageModel) return;
  patch(tabId, { question: asked, asking: true, answer: null, failed: false });

  const text = v.safeParse(
    v.string(),
    await webviews
      .get(tabId)
      ?.evaluate(READ_TEXT)
      .catch(() => null),
  );

  const answer = await askPageModel.ask(tab.customTitle || tab.title, tab.url, text.success ? text.output : "", asked).catch(() => null);

  if (askStateOf(tabId).question !== asked) return;
  patch(tabId, { asking: false, answer, failed: !answer });
}
