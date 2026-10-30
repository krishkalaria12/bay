import type { ExtensionSearchEngine, FetchLike, SearchEngine } from "@bay/core";

/** allEngines exposes the first native record for each extension ID. */
export function suggestionProfile(engine: SearchEngine, records: readonly ExtensionSearchEngine[]): string | null {
  if (!engine.extension) return "";
  const owner = records.find((record) => record.extensionId === engine.extension!.id);
  return owner && owner.url === engine.url && owner.suggestUrl === engine.suggestUrl ? owner.profile : null;
}

type NativeSuggestions = (url: string) => Promise<{ body: string }>;

/** Native requests avoid page CORS, while retaining the fetcher's abort contract. */
export function createSuggestionFetch(browserFetch: FetchLike, native?: NativeSuggestions): FetchLike {
  if (!native) return browserFetch;
  return (url, { signal }) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Search suggestions cancelled"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      void Promise.resolve()
        .then(() => {
          if (signal.aborted) throw new Error("Search suggestions cancelled");
          return native(url);
        })
        .then(
          (result) => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) return;
            if (!result || typeof result.body !== "string") return reject(new Error("Invalid native suggestion response"));
            resolve({ ok: true, text: async () => result.body });
          },
          (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
    });
}
