import { fromMarkdown } from "mdast-util-from-markdown";
import { toHast } from "mdast-util-to-hast";
import { sanitize } from "hast-util-sanitize";
import { expect, test } from "vitest";
import { RICH_SCHEMA } from "../src/lib/chat-sanitize-schema";

function render(md: string): unknown {
  const mdast = fromMarkdown(md);
  const hast = toHast(mdast);
  return sanitize(hast, RICH_SCHEMA);
}

function tags(hast: unknown): string[] {
  const out: string[] = [];
  function walk(n: any): void {
    if (n?.type === "element") out.push(n.tagName);
    if (Array.isArray(n?.children)) for (const c of n.children) walk(c);
  }
  walk(hast);
  return out;
}

test("strips javascript: href", () => {
  const root = render("[x](javascript:alert(1))");
  expect(tags(root)).toContain("a"); // link kept, but…
  function href(n: any): string | undefined {
    if (n?.type === "element" && n.tagName === "a") return n.properties?.href;
    if (Array.isArray(n?.children))
      for (const c of n.children) {
        const v = href(c);
        if (v !== undefined) return v;
      }
    return undefined;
  }
  expect(href(root)).toBeUndefined();
});

test("strips data: image sources", () => {
  const root = render("![x](data:image/png;base64,AAAA)");
  expect(tags(root)).not.toContain("img");
});

test("preserves text formatting from defaultSchema", () => {
  expect(tags(render("**bold**"))).toContain("strong");
  expect(tags(render("`code`"))).toContain("code");
  expect(tags(render("[ok](https://example.com)"))).toContain("a");
});