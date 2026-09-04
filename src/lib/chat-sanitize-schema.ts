import { defaultSchema } from "rehype-sanitize";

/**
 * Per the 2026-09-04 review (H3): every chat line rich enough to render
 * Markdown runs through this schema, never the unmodified default. The
 * `defaultSchema` *does* strip `javascript:` hrefs today, but a future
 * upgrade or a hand-rolled override would silently lose that, so the
 * deny list is explicit and pinned in source.
 *
 * Differences from `defaultSchema`:
 *   - `href`/`src` allow http(s) and mailto; everything else (data:, file:,
 *     vbscript:, javascript:) is stripped.
 *   - `img` is dropped wholesale: a malicious LLM could embed tracking
 *     pixels that fire on every render and leak the user's IP.
 *   - `style` is dropped: any attribute-based styling is out, and so is
 *     the `style` element itself.
 *   - No `iframe`, `object`, or `embed`: render is text-only.
 *   - No `class`/`id`: harness-stable rendering and no script-targeted
 *     hooks.
 */
export const RICH_SCHEMA = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t: string) =>
    !["iframe", "object", "embed", "style", "img"].includes(t),
  ),
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  attributes: Object.fromEntries(
    Object.entries(defaultSchema.attributes ?? {}).map(([k, v]) => [
      k,
      (v as string[] | undefined)?.filter((a) => !["class", "id", "style"].includes(a)) ?? [],
    ]),
  ),
} as typeof defaultSchema;