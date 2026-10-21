import { hasServiceClient, requestService } from "../runtime/serviceClient";
import { type BrowserStore } from "../store/browser";
import { browserRead } from "../store/read";
import { closeTab, newTab } from "../runtime/tabActions";
import { GOOGLE_REDIRECT, GOOGLE_SCOPE } from "./constants";
import { endpoints, form } from "./net";
import { connectGoogle } from "./sources";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const random = (n: number) => Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");

let owner: BrowserStore | undefined;
export function bindGoogleBrowser(browser: BrowserStore): () => void {
  owner = browser;
  return () => {
    if (owner === browser) {
      pending?.cancel();
      owner = undefined;
    }
  };
}
const read = () => owner?.getState() ?? browserRead.getState();
let pending: { cancel(): void } | null = null;

function query(url: string): Map<string, string> {
  const search = url.split("#")[0]!.split("?")[1] ?? "";
  return new Map(
    search
      .split("&")
      .filter(Boolean)
      .map((pair) => pair.split("=").map((v) => decodeURIComponent(v.replace(/\+/g, " "))) as [string, string]),
  );
}

export function connectGoogleDrive(windowId: string, clientId: string, clientSecret: string): Promise<void> {
  if (hasServiceClient()) return requestService("googleConnect", [windowId, clientId, clientSecret]);
  pending?.cancel();
  const verifier = random(64);
  const state = random(24);
  const url = `${endpoints.googleAuth}?${form({
    client_id: clientId.trim(),
    redirect_uri: GOOGLE_REDIRECT,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    code_challenge: verifier,
    code_challenge_method: "plain",
    state,
    access_type: "offline",
    prompt: "consent",
  })}`;
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    let settled = false;
    const request = { cancel: () => finish(new Error("Cancelled")) };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stop();
      if (pending === request) pending = null;
      if (error) reject(error);
      else resolve();
    };
    pending = request;
    void Promise.resolve(owner ? owner.getState().newTab(windowId, { url }) : newTab(windowId, { url }))
      .then((tabId) => {
        if (settled) return;
        const check = () => {
          const tab = read().tabs[tabId];
          if (!tab) return finish(new Error("Sign-in was cancelled"));
          if (!tab.url.startsWith(GOOGLE_REDIRECT)) return;
          const params = query(tab.url);
          if (params.get("state") !== state) return finish(new Error("Sign-in didn't match this request"));
          const code = params.get("code");
          stop();
          void Promise.resolve(owner ? owner.getState().closeTab(tabId) : closeTab(tabId)).catch((error) =>
            console.error("Couldn't close the sign-in tab", error),
          );
          if (!code) return finish(new Error(params.get("error") ?? "Google didn't grant access"));
          connectGoogle(clientId.trim(), clientSecret.trim(), code, verifier, GOOGLE_REDIRECT).then(() => finish(), finish);
        };
        stop = (owner ?? browserRead).subscribe(check);
        check();
      })
      .catch(finish);
  });
}
