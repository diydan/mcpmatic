/**
 * A WebMCP implementation installed into the *remote* page before any of its
 * own scripts run.
 *
 * Why this exists. `document.modelContext` is a browser API behind a Chrome
 * origin trial. A storefront that ships WebMCP only ever *reads* it — Shopify's
 * `webmcp-0.1.1.js` does `'modelContext' in document ? document.modelContext
 * : ...` and registers nothing when the answer is no. Cloudflare's Browser
 * Rendering Chromium has no such API, so on that browser a WebMCP storefront
 * silently exposes no tools at all.
 *
 * This is NOT injecting a tool surface into someone else's origin. It adds no
 * tools. It supplies the platform capability the site's own code is already
 * written against, and the site registers its own handlers on it — the same
 * thing an origin-trial Chrome does. If the remote browser ever ships the real
 * API, this defers to it and does nothing.
 */
export const WEBMCP_POLYFILL = `(() => {
  if (typeof document === "undefined") return;
  if ("modelContext" in document && document.modelContext) return;

  const tools = new Map();
  const bus = new EventTarget();
  const changed = () => bus.dispatchEvent(new Event("toolchange"));

  const ctx = {
    async registerTool(tool, options) {
      if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
        throw new DOMException("invalid tool", "InvalidStateError");
      }
      if (tools.has(tool.name)) {
        throw new DOMException("duplicate tool", "InvalidStateError");
      }
      if (options && options.signal && options.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      tools.set(tool.name, {
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        execute: tool.execute,
      });
      if (options && options.signal) {
        options.signal.addEventListener("abort", () => {
          tools.delete(tool.name);
          changed();
        }, { once: true });
      }
      changed();
      return {
        unregister() { tools.delete(tool.name); changed(); },
      };
    },
    async getTools() {
      return Array.from(tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        origin: location.origin,
        window: window,
      }));
    },
    async executeTool(tool, input) {
      const name = typeof tool === "string" ? tool : tool && tool.name;
      const rec = tools.get(name);
      if (!rec) throw new DOMException("unknown tool", "NotFoundError");
      const out = await rec.execute(input || {});
      return typeof out === "string" ? out : JSON.stringify(out);
    },
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus),
  };

  Object.defineProperty(document, "modelContext", {
    value: ctx,
    configurable: true,
    enumerable: false,
  });
  // Marker so the worker can report honestly whether the site's tools ran on
  // a real implementation or on this one.
  Object.defineProperty(window, "__browsermaticPolyfilledWebMCP", {
    value: true,
    configurable: true,
  });
})();`;
