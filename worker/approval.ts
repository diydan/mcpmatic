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
    const id = crypto.randomUUID();
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

export type PreparedFills =
  | { ok: true; args: Record<string, unknown>; resolved: string[] }
  | { ok: false; text: string };

/**
 * Complete a call's arguments with profile fields, asking a human if they are
 * not already there.
 *
 * The trigger is absence, not declaration, which is what lets one rule serve
 * both entry points: a façade call arrives already merged and runs straight
 * through, an MCP call arrives bare and suspends. `resolved` is what actually
 * moved — the audit row names that, not the manifest's declaration.
 */
export async function prepareFills(
  declared: readonly string[] | undefined,
  args: Record<string, unknown>,
  gate: Pick<ApprovalGate, "request">,
  ask?: { origin: string; tool: string },
): Promise<PreparedFills> {
  const missing = missingFills(declared, args);
  if (!missing.length) {
    const already = (declared ?? []).filter((p) => args[p] !== undefined);
    return { ok: true, args, resolved: already };
  }
  const outcome = await gate.request({
    origin: ask?.origin ?? "",
    tool: ask?.tool ?? "",
    fieldNames: missing,
  });
  if (!outcome.ok) {
    return { ok: false, text: approvalFailureText(outcome.reason, missing) };
  }
  const supplied = (declared ?? []).filter((p) => args[p] !== undefined);
  return {
    ok: true,
    args: { ...args, ...outcome.fills },
    resolved: [...supplied, ...Object.keys(outcome.fills)],
  };
}
