export type PageElement = {
  role: string;
  name: string;
  selector: string;
};

export type CaptureFn = (fn: () => Promise<PageElement[]>) => Promise<PageElement[]>;

/**
 * Snapshot of the live page's interactive elements, for manifest generation
 * to propose steps against. Same `evaluate` abstraction `native-webmcp.ts`
 * already uses to read `document.modelContext` — no new CDP domain.
 *
 * Capped at 150 elements: bounds what reaches the model, mirroring the
 * 8000-character cap `sanitizeSchema` already applies to a discovered
 * tool's schema.
 */
export async function captureInteractiveElements(evaluate: CaptureFn): Promise<PageElement[]> {
  try {
    const elements = await evaluate(captureInPage);
    return elements.slice(0, 150);
  } catch {
    // Page navigated mid-call, closed, or evaluate threw for any other
    // reason — an empty capture, not a crash. generate-manifest.ts turns
    // an empty list into its own "invalid-response" outcome.
    return [];
  }
}

/**
 * Serialized into the remote page by Playwright. Do not close over worker
 * state — same constraint `native-webmcp.ts`'s `nativeCall`/`nativeList`
 * document for the same reason.
 *
 * The worker tsconfig carries no DOM lib (`lib: ["ES2022"]`, workers-types
 * only — where `Element` means HTMLRewriter's, not the DOM's), so this
 * declares the minimal structural shapes it touches and reads `document`
 * off `globalThis`, the same way `native-webmcp.ts` reaches `modelContext`.
 */
type CapturedEl = {
  id: string;
  tagName: string;
  type?: string;
  value?: unknown;
  textContent: string | null;
  parentElement: CapturedEl | null;
  children: ArrayLike<CapturedEl>;
  getAttribute: (name: string) => string | null;
};

type CapturedDoc = {
  body: CapturedEl | null;
  querySelector: (selector: string) => CapturedEl | null;
  querySelectorAll: (selector: string) => ArrayLike<CapturedEl>;
};

async function captureInPage(): Promise<Array<{ role: string; name: string; selector: string }>> {
  const doc = (globalThis as { document?: CapturedDoc }).document;
  if (!doc) return [];

  function selectorFor(el: CapturedEl): string {
    const parts: string[] = [];
    let node: CapturedEl | null = el;
    while (node && node !== doc!.body) {
      if (node.id) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const parent: CapturedEl | null = node.parentElement;
      if (!parent) break;
      const current: CapturedEl = node;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      node = parent;
    }
    return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
  }

  function roleFor(el: CapturedEl): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "form") return "form";
    if (tag === "input") {
      const type = el.type;
      return type === "submit" || type === "button" ? "button" : "textbox";
    }
    return tag;
  }

  function nameFor(el: CapturedEl): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.id) {
      // Quote-escaped attribute selector rather than CSS.escape, which the
      // worker tsconfig has no type for and older engines may not ship.
      const escaped = el.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const label = doc!.querySelector(`label[for="${escaped}"]`);
      const labelText = label?.textContent;
      if (labelText) return labelText.trim().slice(0, 100);
    }
    const text = el.textContent?.trim();
    if (text) return text.slice(0, 100);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const value = el.value;
    return value ? String(value).trim() : "";
  }

  const found = doc.querySelectorAll("button, a, input, select, textarea, [role], form");
  return Array.from(found)
    .slice(0, 150)
    .map((el) => ({ role: roleFor(el), name: nameFor(el), selector: selectorFor(el) }));
}
