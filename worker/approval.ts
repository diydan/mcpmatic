/**
 * Human approval for tools that draw on the local profile.
 *
 * The profile lives in the console's localStorage and is never on the server
 * (`src/lib/profile-store.ts`), so a tool declaring `fillsFrom` cannot run
 * unattended. The façade path resolves those fields in the page before the
 * arguments cross the wire (`src/lib/register-all.ts`); the MCP path has no
 * page, so it must ask.
 *
 * Nothing here holds a value beyond the life of one call.
 */

/**
 * Which declared profile paths the caller did not supply.
 *
 * The trigger is *missing* fills, not declared ones: a façade-initiated call
 * arrives with its fields already merged, so it runs straight through and the
 * human is not asked to bless the same action twice.
 */
export function missingFills(
  declared: readonly string[] | undefined,
  args: Record<string, unknown>,
): string[] {
  if (!declared?.length) return [];
  return declared.filter((path) => args[path] === undefined);
}

/**
 * Drop any argument whose key is a declared profile path.
 *
 * Applied at the MCP entry only. Without it a client could pass
 * `{"address.line1": "…"}`, satisfy `missingFills`, and route around the
 * approval entirely — and the audit row would then name profile fields that
 * were never the user's profile. The façade path is deliberately not stripped:
 * it merges its fields *after* its own bless.
 */
export function stripProfilePaths(
  declared: readonly string[] | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!declared?.length) return args;
  const paths = new Set(declared);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (paths.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export type ApprovalRequestPayload = {
  id: string;
  origin: string;
  tool: string;
  fieldNames: string[];
  expiresAt: number;
};

export type BoundedOutcome =
  | { status: "approved"; fills: Record<string, string> }
  | { status: "denied" }
  | { status: "needs-console" }
  /** Not answered in the inline window. Collect it later with this id. */
  | { status: "pending"; id: string };

export type ApprovalOutcome =
  | { ok: true; fills: Record<string, string> }
  | {
      ok: false;
      reason: "needs-console" | "denied" | "timeout" | "disconnected";
    };

type Pending = {
  fieldNames: string[];
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Suspends a tool call until a human answers, or until it is clear no human
 * will.
 *
 * Every path settles exactly once — approve, deny, timeout, or the console
 * going away — because an MCP client's request is waiting on the other end and
 * a stranded call is worse than a refused one. Same discipline as the
 * `tool_call` / `tool_result` pair the in-page agent already uses.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly opts: {
      hasConsole: () => boolean;
      send: (req: ApprovalRequestPayload) => void;
      timeoutMs: number;
    },
  ) {}

  request(input: {
    origin: string;
    tool: string;
    fieldNames: string[];
  }): Promise<ApprovalOutcome> {
    if (!this.opts.hasConsole()) {
      return Promise.resolve({ ok: false, reason: "needs-console" });
    }
    return this.open(crypto.randomUUID(), input);
  }

  /** Publish a request and return the promise its answer will settle. */
  private open(
    id: string,
    input: { origin: string; tool: string; fieldNames: string[] },
  ): Promise<ApprovalOutcome> {
    const expiresAt = Date.now() + this.opts.timeoutMs;
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: "timeout" });
      }, this.opts.timeoutMs);
      this.pending.set(id, { fieldNames: input.fieldNames, resolve, timer });
      this.opts.send({ id, expiresAt, ...input });
    });
  }

  /**
   * Wait a little, then hand back a handle instead of holding the caller open.
   *
   * A human decision has no upper bound, and an MCP request does: the SDK's
   * default is 60 seconds. Blocking for the whole approval window spends the
   * client's entire budget on one call and — worse — leaves the request
   * exposed for that whole time to a Durable Object reset, which orphans it.
   * A reset destroys the pending map, the resolve callbacks and the timer at
   * once, and the caller waits until the platform errors it. That is not
   * hypothetical; it is what a deployed run did.
   *
   * So: wait `inlineMs`, which covers the case that actually matters — the
   * human is watching the console and clicks in a few seconds. If they are not
   * there, return the id. The request stays live; when it is finally answered
   * or expires, `onLate` runs the work and the caller collects the result by
   * id.
   *
   * Nothing is blocked on the expiry timer any more, which is why a plain
   * `setTimeout` is adequate here despite the rest of this class living in a
   * Durable Object: if a reset takes the timer, no caller is waiting on it.
   */
  async requestBounded(
    input: { origin: string; tool: string; fieldNames: string[] },
    inlineMs: number,
    onLate: (outcome: ApprovalOutcome, id: string) => Promise<void>,
  ): Promise<BoundedOutcome> {
    if (!this.opts.hasConsole()) return { status: "needs-console" };
    const id = crypto.randomUUID();
    const settled = this.open(id, input);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<"inline-expired">((resolve) => {
      timer = setTimeout(() => resolve("inline-expired"), inlineMs);
    });
    const first = await Promise.race([settled, elapsed]);
    if (timer !== undefined) clearTimeout(timer);

    if (first !== "inline-expired") {
      if (first.ok) return { status: "approved", fills: first.fills };
      return first.reason === "denied"
        ? { status: "denied" }
        : { status: "needs-console" };
    }
    // Hand the caller a receipt and let the decision land later.
    void settled.then((outcome) => onLate(outcome, id));
    return { status: "pending", id };
  }

  /**
   * The console went away — socket closed, page reloaded, session torn down.
   * Nobody is going to answer, so say so now rather than making every waiting
   * caller sit out its timeout.
   */
  abandonAll(): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, reason: "disconnected" });
    }
  }

  /** Answer from the console. Unknown or already-settled ids are ignored. */
  settle(id: string, ok: boolean, fills?: Record<string, string>): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (!ok) {
      entry.resolve({ ok: false, reason: "denied" });
      return;
    }
    // The request named the fields; only those resolve. The console does not
    // get to decide what travels — same rule `resolveFields` enforces on the
    // page.
    const allowed: Record<string, string> = {};
    for (const path of entry.fieldNames) {
      const value = fills?.[path];
      if (typeof value === "string") allowed[path] = value;
    }
    entry.resolve({ ok: true, fills: allowed });
  }
}

/**
 * What the agent is told when an approval does not produce fields.
 *
 * Never a fake success: the tool that could not fill says it could not fill,
 * and says what would unblock it. Field paths only — a value has no business
 * in a tool result any more than it has in the audit table.
 */
export function approvalFailureText(
  reason: Extract<ApprovalOutcome, { ok: false }>["reason"],
  fieldNames: readonly string[],
): string {
  const fields = fieldNames.join(", ");
  switch (reason) {
    case "needs-console":
      return `needs-console: open the mcpmatic console to approve ${fields}`;
    case "denied":
      // Same words register-all.ts throws on the façade path. One event, one
      // vocabulary, whichever surface the caller came from.
      return "user denied: profile fields not sent";
    case "timeout":
      return `approval timed out: nobody approved ${fields}`;
    case "disconnected":
      return `the mcpmatic console closed before approving ${fields}`;
  }
}
