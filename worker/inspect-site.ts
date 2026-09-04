import type { DiscoveredTool } from "../shared/protocol";

/**
 * What a page exposes, whether or not it publishes WebMCP.
 *
 * A description of structure, never a copy of the page: field names and
 * shapes, no page text and no values. Enough for a person to see whether a
 * tool is possible here, and enough for a generator to build one later.
 */
export type PageInspection = {
  url: string;
  searchActions: { urlTemplate: string }[];
  forms: {
    action: string;
    method: string;
    fields: { name: string; type: string; required: boolean }[];
  }[];
  searchInputs: { selector: string; name?: string }[];
  interactiveCount: number;
};

/**
 * The DOM surface this needs, declared structurally.
 *
 * The Worker has no DOM lib and should not pull one in for code whose only
 * job is to be serialized into a page. Same approach `native-webmcp.ts` takes
 * with `document.modelContext`.
 */
type El = {
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  querySelectorAll: (selector: string) => ArrayLike<El>;
  textContent: string | null;
  tagName: string;
};
type Doc = { querySelectorAll: (selector: string) => ArrayLike<El> };

/** A page is remote input; every list it produces is bounded. */
export const MAX_FORMS = 20;
export const MAX_FIELDS = 30;
export const MAX_SEARCH_INPUTS = 10;

/**
 * Runs inside the remote page. Reads globals only and closes over nothing, so
 * it survives being serialized by `page.evaluate` — the same constraint
 * `nativeCall` documents in native-webmcp.ts.
 *
 * Declarations before inference: JSON-LD first, because a site that published
 * a SearchAction has told machines how to search it; then forms, which are
 * already tool schemas; then loose search inputs, which are a guess.
 */
export function collectInspection(): PageInspection {
  const g = globalThis as unknown as {
    document?: Doc;
    location?: { href?: string };
  };
  const doc = g.document;
  const out: PageInspection = {
    url: g.location?.href ?? "",
    searchActions: [],
    forms: [],
    searchInputs: [],
    interactiveCount: 0,
  };
  if (!doc) return out;

  for (const node of Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(node.textContent || "");
    } catch {
      continue; // a malformed block is not a reason to abandon the page
    }
    for (const action of findSearchActions(parsed)) {
      out.searchActions.push(action);
    }
  }

  for (const form of Array.from(doc.querySelectorAll("form")).slice(0, MAX_FORMS)) {
    const fields: PageInspection["forms"][number]["fields"] = [];
    for (const el of Array.from(form.querySelectorAll("input, select, textarea"))) {
      const name = el.getAttribute("name");
      // A field with no name cannot be filled by name, so it is not a field
      // any generated tool could use.
      if (!name) continue;
      if (fields.length >= MAX_FIELDS) break;
      fields.push({
        name,
        type: el.getAttribute("type") || el.tagName.toLowerCase().replace("input", "text"),
        required: el.hasAttribute("required"),
      });
    }
    out.forms.push({
      action: form.getAttribute("action") || out.url,
      method: (form.getAttribute("method") || "get").toLowerCase(),
      fields,
    });
  }

  const SEARCH_NAMES = new Set(["q", "s", "query", "search", "keyword"]);
  for (const el of Array.from(doc.querySelectorAll("input"))) {
    if (out.searchInputs.length >= MAX_SEARCH_INPUTS) break;
    const name = el.getAttribute("name") || undefined;
    const looksLikeSearch =
      el.getAttribute("type") === "search" ||
      el.getAttribute("role") === "searchbox" ||
      (name ? SEARCH_NAMES.has(name.toLowerCase()) : false);
    if (!looksLikeSearch) continue;
    out.searchInputs.push({
      selector: name ? `input[name="${name}"]` : "input[type=search]",
      name,
    });
  }

  out.interactiveCount = doc.querySelectorAll(
    "button, a[href], input, select, textarea, [role]",
  ).length;

  return out;
}

/** Walk any JSON-LD shape for SearchAction targets. Sites nest these freely. */
function findSearchActions(node: unknown, depth = 0): { urlTemplate: string }[] {
  if (depth > 6 || !node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.flatMap((n) => findSearchActions(n, depth + 1));
  }
  const obj = node as Record<string, unknown>;
  const found: { urlTemplate: string }[] = [];
  if (obj["@type"] === "SearchAction") {
    const target = obj.target;
    const template =
      typeof target === "string"
        ? target
        : target && typeof target === "object"
          ? (target as { urlTemplate?: unknown }).urlTemplate
          : undefined;
    if (typeof template === "string" && template) found.push({ urlTemplate: template });
  }
  for (const value of Object.values(obj)) {
    found.push(...findSearchActions(value, depth + 1));
  }
  return found;
}

export type InspectFn = (fn: () => PageInspection) => Promise<PageInspection>;

/**
 * A page that navigated mid-call, or closed, is an empty inspection rather
 * than a thrown error — same rule `callNativeTool` follows.
 */
export async function inspectPage(
  evaluate: InspectFn,
  tools: DiscoveredTool[] = [],
): Promise<PageInspection & { webmcpTools: DiscoveredTool[] }> {
  try {
    return { ...(await evaluate(collectInspection)), webmcpTools: tools };
  } catch {
    return {
      url: "",
      searchActions: [],
      forms: [],
      searchInputs: [],
      interactiveCount: 0,
      webmcpTools: tools,
    };
  }
}

/**
 * The report a human or an agent reads.
 *
 * A site that publishes tools leads with them. A site that publishes none gets
 * what it *does* expose, stated as a fact rather than a fault — "no WebMCP" is
 * the normal case on today's web, not an error.
 *
 * Field names only, never values, and never page text.
 */
export function describeInspection(
  page: PageInspection & { webmcpTools: DiscoveredTool[] },
): string {
  const lines: string[] = [];

  if (page.webmcpTools.length) {
    const n = page.webmcpTools.length;
    lines.push(
      `${page.url} publishes ${n} WebMCP tool${n === 1 ? "" : "s"} of its own: ` +
        page.webmcpTools.map((t) => t.name).join(", "),
    );
  } else {
    lines.push(`No WebMCP on ${page.url}. What it does expose:`);
  }

  for (const action of page.searchActions) {
    lines.push(`- a published JSON-LD SearchAction: ${action.urlTemplate}`);
  }
  for (const form of page.forms) {
    const fields = form.fields
      .map((f) => (f.required ? `${f.name}*` : f.name))
      .join(", ");
    lines.push(
      `- a form: ${form.method.toUpperCase()} ${form.action}` +
        (fields ? ` (${fields})` : " (no named fields)"),
    );
  }
  const looseSearch = page.searchInputs.filter(
    (i) => !page.forms.some((f) => f.fields.some((x) => x.name === i.name)),
  );
  for (const input of looseSearch) {
    lines.push(`- a search box: ${input.selector}`);
  }
  if (page.interactiveCount) {
    lines.push(`- ${page.interactiveCount} interactive controls in total`);
  }
  if (lines.length === 1 && !page.webmcpTools.length) {
    lines.push("- nothing a tool could be built from yet");
  }
  // `*` marks a field the site says is required. Say so, rather than leaving a
  // reader to guess at punctuation.
  if (page.forms.some((f) => f.fields.some((x) => x.required))) {
    lines.push("(* required)");
  }
  return lines.join("\n");
}
