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
  querySelectorAll: (selector: string) => ArrayLike<CapturedEl>;
};

type CapturedDoc = {
  body: CapturedEl | null;
  querySelector: (selector: string) => CapturedEl | null;
  querySelectorAll: (selector: string) => ArrayLike<CapturedEl>;
};

export async function captureInPage(): Promise<Array<{ role: string; name: string; selector: string }>> {
  const doc = (globalThis as { document?: CapturedDoc }).document;
  if (!doc) return [];

  // Declared inside the function, not at module scope: this body is
  // stringified and evaluated in the remote page, so a reference to anything
  // outside it is a ReferenceError there — while still resolving fine when a
  // test calls the function directly in Node.
  const INTERACTIVE = "button, a, input, select, textarea, [role], form";

  /**
   * Escape for use inside a double-quoted attribute selector. Not CSS.escape:
   * the worker tsconfig has no type for it, and an `#id` selector cannot carry
   * an id containing a space, dot, colon, or leading digit at all.
   */
  function escapeAttr(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * True only if exactly one element in the document carries this id. Real
   * pages do repeat ids, and anchoring on a repeated one produces a selector
   * that silently resolves to the first match: page.click does not error on
   * a multi-match, it acts on the wrong element — after a human approved the
   * tool believing it targets the other one.
   */
  const idIsUnique = new Map<string, boolean>();
  function uniqueId(id: string): boolean {
    const cached = idIsUnique.get(id);
    if (cached !== undefined) return cached;
    let unique = false;
    try {
      unique = doc!.querySelectorAll(`[id="${escapeAttr(id)}"]`).length === 1;
    } catch {
      unique = false;
    }
    idIsUnique.set(id, unique);
    return unique;
  }

  function selectorFor(el: CapturedEl): string {
    const parts: string[] = [];
    let node: CapturedEl | null = el;
    while (node && node !== doc!.body) {
      if (node.id && uniqueId(node.id)) {
        parts.unshift(`[id="${escapeAttr(node.id)}"]`);
        break;
      }
      const parent: CapturedEl | null = node.parentElement;
      if (!parent) break;
      const current: CapturedEl = node;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      // nth-of-type, not nth-child: the index above counts same-tag siblings,
      // and nth-child counts every child, so the two disagree whenever an
      // element has siblings of another tag.
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
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
      const label = doc!.querySelector(`label[for="${escapeAttr(el.id)}"]`);
      const labelText = label?.textContent;
      if (labelText) return labelText.trim().slice(0, 100);
    }
    // textContent is the whole subtree, so for a container of other captured
    // elements — a form, a div[role] wrapping a panel — it concatenates every
    // descendant's text into one blob. That is not a name: it burns prompt on
    // noise and buries the fields the model is supposed to distinguish. A
    // <button><span>Go</span></button> has no interactive descendants and
    // still names itself from its text.
    let containsInteractive = false;
    try {
      containsInteractive = el.querySelectorAll(INTERACTIVE).length > 0;
    } catch {
      containsInteractive = false;
    }
    if (!containsInteractive) {
      const text = el.textContent?.trim();
      if (text) return text.slice(0, 100);
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const value = el.value;
    if (value) return String(value).trim();
    const named = el.getAttribute("name");
    return named ? named.trim() : "";
  }

  const found = doc.querySelectorAll(INTERACTIVE);
  return Array.from(found)
    .slice(0, 150)
    .map((el) => ({ role: roleFor(el), name: nameFor(el), selector: selectorFor(el) }));
}
