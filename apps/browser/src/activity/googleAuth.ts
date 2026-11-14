// Google sign-in uses the same scoped connection service as the other accounts.
import type { BrowserStore } from "../store/browserStore";
import { cancelConnection } from "./connections";

export { connectGoogleDrive } from "./connections";

/** The runtime supplies the authority store; this compatibility hook owns flow cancellation. */
export function bindGoogleBrowser(_browser: BrowserStore): () => void {
  return () => cancelConnection("gdrive");
}
