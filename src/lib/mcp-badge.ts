/**
 * Does the page in the viewport speak WebMCP for itself?
 *
 * This is the distinction the whole product turns on. A site that ships
 * WebMCP is being *asked* — we call the tools it registered, unchanged. A
 * site that does not is being *driven*, through tools synthesised from its
 * DOM and approved by a human first. "Actions on this page" showed the
 * difference only by whether a tool list or a line of prose appeared, which
 * meant reading the panel to work out which world you were in.
 *
 * `remoteToolCount` is what `list_remote_tools` found on the open page. With
 * no page open there is nothing to claim either way.
 */

export type McpBadge = {
  label: string;
  /** True when the site registered the tools itself. */
  native: boolean;
};

export function mcpBadge(args: {
  origin: string | null;
  remoteToolCount: number;
}): McpBadge | null {
  if (!args.origin) return null;
  return args.remoteToolCount > 0
    ? { label: "WebMCP native", native: true }
    : { label: "No WebMCP — driven", native: false };
}
