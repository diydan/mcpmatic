/**
 * What the page told us went wrong, for the operator and the model to read.
 *
 * A synthesised tool replays selectors captured earlier, and `runStep`
 * swallows a failed fill or click on purpose — a checkout step whose field is
 * absent should not abort the run. That means the loudest signal a broken
 * tool produces is nothing at all. These entries are the other half of the
 * picture: the page's own errors, kept per session so a human reviewing a
 * draft (or debugging a approved one) can see what the page thought happened.
 *
 * Privacy. Unlike the audit table, which deliberately has no value column,
 * console text is written by the site and can quote anything the page had —
 * including something the operator typed. So this buffer is memory-only,
 * never written to SQLite or KV, and every entry is truncated. It is a
 * debugging aid, not a record.
 *
 * Lifecycle. The buffer belongs to the session, and a fresh browser launch
 * clears it — otherwise the errors of a torn-down browser would be reported
 * as the new one's. Entries stay readable after a browser closes, which is
 * the point: the operator asks what went wrong *after* it went wrong.
 */

export type PageErrorKind = "pageerror" | "console" | "requestfailed" | "http";

export type PageErrorEntry = {
  kind: PageErrorKind;
  /** Message text, truncated. Never assumed to be safe to persist. */
  text: string;
  url?: string;
  status?: number;
  ts: number;
};

/** Bounded so a page in a console-logging loop cannot grow the DO's memory. */
export const PAGE_ERROR_LIMIT = 100;
const TEXT_MAX = 300;

function clean(value: unknown): string {
  return (
    String(value ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, TEXT_MAX)
  );
}

/** A ring of the most recent entries; the oldest is dropped, never the newest. */
export class PageErrorLog {
  private entries: PageErrorEntry[] = [];

  record(entry: Omit<PageErrorEntry, "ts"> & { ts?: number }): void {
    this.entries.push({
      kind: entry.kind,
      text: clean(entry.text),
      ...(entry.url ? { url: clean(entry.url) } : {}),
      ...(typeof entry.status === "number" ? { status: entry.status } : {}),
      ts: entry.ts ?? Date.now(),
    });
    if (this.entries.length > PAGE_ERROR_LIMIT) {
      this.entries.splice(0, this.entries.length - PAGE_ERROR_LIMIT);
    }
  }

  /**
   * Oldest first. Non-destructive: two readers (MCP and the page) both see it.
   * Each entry is copied too — a shallow array copy still hands out the live
   * objects, so a caller could rewrite a recorded error's text.
   */
  all(): PageErrorEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

/** The slice of Playwright's Page this module needs. */
export type PageEventSource = {
  on?: (event: string, handler: (payload: unknown) => void) => void;
};

type ConsoleMessage = { type?: () => string; text?: () => string };
type FailedRequest = { url?: () => string; failure?: () => { errorText?: string } | null };
type PageResponse = { url?: () => string; status?: () => number };

/**
 * Subscribe to the page's own error channels. Every handler is defensive: a
 * throw inside one would surface as an unhandled rejection in the DO, and a
 * binding without `page.on` (or with a different event set) must degrade to
 * capturing nothing rather than failing the browser launch.
 */
export function attachPageErrorCapture(page: PageEventSource, log: PageErrorLog): boolean {
  if (typeof page.on !== "function") return false;
  const on = page.on.bind(page);
  const safe =
    (handler: (payload: unknown) => void) =>
    (payload: unknown): void => {
      try {
        handler(payload);
      } catch {
        /* a malformed event is not worth taking the session down for */
      }
    };

  try {
    on(
      "pageerror",
      safe((err) => {
        const e = err as { message?: string } | undefined;
        log.record({ kind: "pageerror", text: e?.message ?? String(err) });
      }),
    );
    on(
      "console",
      safe((msg) => {
        const m = msg as ConsoleMessage;
        const type = typeof m.type === "function" ? m.type() : "";
        // Only the levels that indicate something went wrong: a chatty page
        // would otherwise fill the ring with logs nobody asked about.
        if (type !== "error" && type !== "warning") return;
        const text = typeof m.text === "function" ? m.text() : "";
        // Chromium logs a console error for every failed subresource, on top
        // of the requestfailed/response event we already record — with the URL,
        // which this line lacks. Keeping both halves the ring's useful depth
        // and pays twice for one problem.
        if (text.startsWith("Failed to load resource")) return;
        log.record({ kind: "console", text });
      }),
    );
    on(
      "requestfailed",
      safe((req) => {
        const r = req as FailedRequest;
        const failure = typeof r.failure === "function" ? r.failure() : null;
        log.record({
          kind: "requestfailed",
          text: failure?.errorText ?? "request failed",
          url: typeof r.url === "function" ? r.url() : undefined,
        });
      }),
    );
    on(
      "response",
      safe((res) => {
        const r = res as PageResponse;
        const status = typeof r.status === "function" ? r.status() : 0;
        // A partial event whose status() gives undefined must not become an
        // "HTTP undefined" row: undefined < 400 is false, so a bare range
        // check lets it through.
        if (!Number.isFinite(status) || status < 400) return;
        log.record({
          kind: "http",
          text: `HTTP ${status}`,
          status,
          url: typeof r.url === "function" ? r.url() : undefined,
        });
      }),
    );
  } catch {
    return false;
  }
  return true;
}

/** Render for a tool result. Newest last, so the tail is the most recent. */
export function describePageErrors(entries: PageErrorEntry[]): string {
  if (entries.length === 0) return "No page errors recorded this session.";
  const lines = entries.map((e) => {
    const where = e.url ? ` ${e.url}` : "";
    return `[${e.kind}]${where} ${e.text}`;
  });
  return `${entries.length} recorded (newest last):\n${lines.join("\n")}`;
}
