// The Worker's bindings (wrangler.jsonc), and its main module, so `exports` in tests knows its handler.
declare global {
  interface Env {
    CHAIN: DurableObjectNamespace<import("./chain").Chain>;
    PAIRING: DurableObjectNamespace<import("./pairing").Pairing>;
  }

  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

export {};
