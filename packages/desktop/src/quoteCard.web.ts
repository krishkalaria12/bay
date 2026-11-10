import { requireNativeModule } from "@bay/platform/native";
import type { QuoteCard } from "./screenCapture";
import { renderQuoteCard } from "./quoteCardCanvas";

export const quoteCards = {
  async copy(card: QuoteCard): Promise<boolean> {
    const canvas = renderQuoteCard(card);

    if (!canvas) return false;
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";

    for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
    const shell = requireNativeModule<{ copyImage(base64: string, sourceURL?: string): Promise<boolean> }>("BayShell");

    return shell.copyImage(btoa(binary), card.url);
  },
};
