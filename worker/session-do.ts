import { DurableObject } from "cloudflare:workers";
import {
  AUDIT_DDL,
  parseClientMessage,
  type AuditRow,
  type BrowserState,
  type ClientMessage,
  type ServerMessage,
  type ToolSchema,
} from "../shared/protocol";
import { runSteps } from "./steps";
import { originSlug } from "../shared/origin";
import { isPrivateUrl } from "./is-private-url";
import { makeResolve4, makeResolve4Records } from "./doh-resolve4";
import { navigationStable } from "./navigation-stable";
import {
  dispatchKey,
  dispatchMouse,
  resumeScreencast,
  startScreencast,
  stopScreencast,
  wrapCdp,
  type CdpSession,
} from "./cdp";
import {
  appendToolResult,
  initialMessages,
  modelPath,
  noModelMessage,
  runTurn,
  type ChatTurn,
} from "./agent";
import { MANIFESTS, manifestFor } from "./manifests";
import type { ToolManifest } from "../shared/manifest";
import { mergeAutonomousConsent } from "../shared/autonomous";
import { buildToolList } from "./mcp/tools";
import {
  callNativeTool,
  discoverNativeTools,
  parseCallRemoteArgs,
  type DiscoverFn,
  type EvaluateFn,
} from "./native-webmcp";
import type { DiscoveredTool } from "../shared/protocol";
import { WEBMCP_POLYFILL } from "./inject-webmcp";
import {
  PageErrorLog,
  attachPageErrorCapture,
  describePageErrors,
  type PageEventSource,
} from "./page-errors";
import {
  ApprovalGate,
  approvalFailureText,
  missingFills,
  stripProfilePaths,
} from "./approval";
import { parseBridgeRole } from "./bridge-role";
import { claimDecision } from "./account";
import { toAuditRows, type StoredAuditRow } from "./audit-rows";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * Under the MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC (60_000), so a stalled
 * approval surfaces as our error rather than the client's own abandonment.
 */
const APPROVAL_TIMEOUT_MS = 45_000;
/**
 * How long a tool call waits inline before handing back an id.
 *
 * Long enough for a human who is already watching the console, short enough
 * that the caller keeps most of its budget and spends little time exposed to a
 * Durable Object reset. See ApprovalGate.requestBounded.
 */
const INLINE_APPROVAL_MS = 10_000;

/**
 * What a tool call answers with. `resolved` names the profile fields that
 * actually moved; `reason` is the failure class site telemetry records.
 */
type ToolResult = {
  ok: boolean;
  text: string;
  resolved?: string[];
  reason?: string;
};
/** Grace after the last client disconnects before the browser is released. */
const IDLE_GRACE_MS = 3 * 60 * 1000;
const VIEWPORT = { width: 1280, height: 720 };

type LiveBrowser = {
  // Playwright types are pulled in at runtime from @cloudflare/playwright.
  browser: { close: () => Promise<void>; disconnect?: () => Promise<void> };
  page: {
    goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
    url: () => string;
    title: () => Promise<string>;
    innerText: (selector: string) => Promise<string>;
    // The options bag matters: without an explicit timeout Playwright waits
    // its 30s default for an element that is simply not on this page.
    fill?: (selector: string, value: string, opts?: { timeout?: number }) => Promise<void>;
    click?: (selector: string, opts?: { timeout?: number }) => Promise<void>;
    press?: (selector: string, key: string, opts?: { timeout?: number }) => Promise<void>;
    waitForSelector?: (selector: string, opts?: { timeout?: number }) => Promise<unknown>;
    evaluate?: EvaluateFn & DiscoverFn;
    context: () => {
      newCDPSession: (page: unknown) => Promise<CdpSession>;
    };
    setViewportSize?: (size: { width: number; height: number }) => Promise<void>;
    addInitScript?: (script: string | { content: string }) => Promise<void>;
    on?: PageEventSource["on"];
  };
  cdp: CdpSession | null;
};

type PendingTurn = {
  messages: ChatTurn[];
  tools: ToolSchema[];
  waitingId: string | null;
};

export class SessionDO extends DurableObject<Env> {
  private live: LiveBrowser | null = null;
  private launching: Promise<LiveBrowser | null> | null = null;
  private pending: PendingTurn | null = null;
  private driving = false;
  private readonly approvals = new ApprovalGate({
    // Console sockets only. A façade socket belongs to an agent, and asking
    // it to approve would put the dialog somewhere no human is reading.
    hasConsole: () => this.ctx.getWebSockets("console").length > 0,
    send: (req) => this.broadcast({ v: 1, type: "approval_request", ...req }),
    timeoutMs: APPROVAL_TIMEOUT_MS,
  });
  private remoteTools: DiscoveredTool[] = [];
  private remoteToolsOrigin: string | null = null;
  /**
   * What the open page reported went wrong. Memory-only and per session by
   * design — see page-errors.ts on why this is not the audit table.
   */
  private pageErrors = new PageErrorLog();
  /**
   * Whether the live browser's page accepted the error subscriptions. False
   * means an empty buffer proves nothing, so get_page_errors must not report
   * a clean page.
   */
  private pageErrorsAttached = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(AUDIT_DDL);
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS approval_results (
           id TEXT PRIMARY KEY,
           ok INTEGER NOT NULL,
           text TEXT NOT NULL,
           ts INTEGER NOT NULL
         )`,
      );
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptBridge(request);
    }
    const url = new URL(request.url);
    if (url.pathname === "/check") {
      // `createSession` in worker/index.ts inserts a sentinel row with the
      // token as its value. The OAuth authorize handler asks the DO "does
      // this session exist?" before binding the token to an auth code — a
      // random pasted string must NOT mint an OAuth code.
      const row = this.ctx.storage.sql
        .exec<{ value: string }>(
          `SELECT value FROM meta WHERE key = 'sessionToken' LIMIT 1`,
        )
        .toArray()[0];
      if (!row) return new Response("not found", { status: 404 });
      return Response.json({ ok: true });
    }
    return new Response("expected websocket", { status: 400 });
  }

  /**
   * RPC called by `createSession` (worker/index.ts) to plant a sentinel
   * row that the OAuth authorize handler's /check reads. Idempotent:
   * re-initializing the same session overwrites the row with the same
   * value, which is fine — the token is regenerated per call anyway.
   *
   * If `origin` is provided it has already been validated by the worker
   * (URL parse, https, isPrivateUrl) — see `parseAndValidateOrigin` in
   * worker/index.ts. We persist the consent alongside the sentinel
   * meta row in a single SQL transaction so partial writes (sentinel
   * without consent, or vice versa) cannot escape into the DO state.
   */
  async initSession(token: string, origin?: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('sessionToken', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        token,
      );
      // The clock starts at mint, not at first bridge accept: a façade URL
      // nobody ever opened is still a session whose consent must not outlive
      // two hours. DO NOTHING keeps a replay of POST /sessions from resetting
      // a clock that is already running.
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('createdAt', ?)
         ON CONFLICT(key) DO NOTHING`,
        String(Date.now()),
      );
      if (origin) {
        // Mirrors `grantConsent`'s storage shape: a single meta row
        // holding the JSON array of consented origins. The seed path is
        // intentionally idempotent against an already-seeded origin so a
        // replay of POST /sessions doesn't corrupt the array.
        const allowed = this.readConsent();
        if (!allowed.includes(origin)) {
          allowed.push(origin);
          this.ctx.storage.sql.exec(
            `INSERT INTO meta (key, value) VALUES ('consent', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            JSON.stringify(allowed),
          );
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('origin', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          origin,
        );
      }
    });
  }

  /**
   * Read-only view of the consent list. Kept synchronous (SQL
   * reads are sync inside a DO) so callers can gate a tool on it without
   * awaiting. The set is what `listTools` filters by and what
   * `runTool` checks via `consented()` before launching a navigation.
   */
  private readConsent(): string[] {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'consent' LIMIT 1`)
      .toArray()[0];
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * Public read of the consent list. Used by the GET /s/<token>/consent
   * route so the Session page can hydrate its `consented` state on mount
   * when an origin was pre-seeded via POST /sessions. Idempotent.
   */
  async listConsent(): Promise<{ consent: string[]; autonomous: boolean }> {
    if (this.expired()) {
      throw new Error("session expired");
    }
    return { consent: this.readConsent(), autonomous: this.readAutonomous() };
  }

  /**
   * Results of calls approved after their caller gave up, keyed by approval
   * id and read back by check_approval.
   *
   * Result text only. A tool result names what ran and where; it never carries
   * a profile value, and there is nowhere here to put one if it did.
   */
  private storeApprovalResult(id: string, result: ToolResult): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO approval_results (id, ok, text, ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, text = excluded.text`,
      id,
      result.ok ? 1 : 0,
      result.text,
      Date.now(),
    );
  }

  private readApprovalResult(id: string): ToolResult | null {
    const row = this.ctx.storage.sql
      .exec<{ ok: number; text: string }>(
        `SELECT ok, text FROM approval_results WHERE id = ? LIMIT 1`,
        id,
      )
      .toArray()[0];
    return row ? { ok: row.ok === 1, text: row.text } : null;
  }

  private accountId(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'accountId' LIMIT 1`,
      )
      .toArray()[0];
    return row?.value ?? null;
  }

  /**
   * The account this session was claimed by, for the passkey registration
   * route only.
   *
   * Server-side callers only: the worker uses it to decide which account an
   * authenticator may be attached to, and never returns it to a client. That
   * is the whole point — registration must prove possession of the session,
   * not merely knowledge of an account id.
   */
  async accountForPasskey(): Promise<{ accountId: string | null }> {
    return { accountId: this.accountId() };
  }

  /**
   * Bind this session to an account, inheriting its grants.
   *
   * Claimed, not replaced: the session keeps its token, its browser and
   * anything already granted, and the account learns those grants too. First
   * claim wins — the token is a bearer credential, so a second account must
   * not be able to bind it and inherit the list.
   */
  async claimAccount(
    accountId: string,
  ): Promise<{ ok: boolean; consent?: string[]; error?: string }> {
    const decision = claimDecision(this.accountId(), accountId);
    if (!decision.ok) return { ok: false, error: decision.reason };
    const { grants } = await this.env.ACCOUNT.getByName(accountId).claim(
      this.sessionToken() ?? "",
      this.readConsent(),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('accountId', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      accountId,
    );
    this.writeConsent(grants);
    this.sendState();
    return { ok: true, consent: grants };
  }

  private sessionToken(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'sessionToken' LIMIT 1`,
      )
      .toArray()[0];
    return row?.value ?? null;
  }

  private writeConsent(origins: readonly string[]): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('consent', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify([...origins]),
    );
  }

  /**
   * Remove an origin from the consent list, here and on the account this
   * session was claimed by. The account write is not awaited, for the same
   * reason `grantConsent`'s is not: consent must answer without waiting on a
   * second Durable Object. Revoking an origin the session never had is a
   * no-op, so a stale console cannot resurrect state by revoking it.
   */
  async revokeConsent(origin: string): Promise<{ ok: true; consent: string[] }> {
    if (this.expired()) {
      throw new Error("session expired");
    }
    const allowed = this.readConsent().filter((o) => o !== origin);
    this.writeConsent(allowed);
    const accountId = this.accountId();
    if (accountId && origin) {
      this.ctx.waitUntil(
        this.env.ACCOUNT.getByName(accountId)
          .revoke(origin)
          .then(() => undefined),
      );
    }
    this.sendState();
    return { ok: true, consent: allowed };
  }

  async grantConsent(origin: string): Promise<{ ok: true }> {
    if (this.expired()) {
      throw new Error("session expired");
    }
    // Write through to the account, if this session has been claimed, so the
    // grant outlives the session's two hours. Not awaited: consent must answer
    // without waiting on a second Durable Object, and the local mirror below
    // is what every read in this class actually uses.
    const accountId = this.accountId();
    if (accountId && origin) {
      this.ctx.waitUntil(
        this.env.ACCOUNT.getByName(accountId)
          .grant(origin)
          .then(() => undefined),
      );
    }
    const allowed = this.readConsent();
    if (!allowed.includes(origin)) {
      allowed.push(origin);
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('consent', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify(allowed),
      );
    }
    // First consent is what earns a browser. Launching on page load meant every
    // visitor burned a Browser Rendering session before granting anything.
    // Only when a client is actually watching: a browser started with no socket
    // has nothing to release it (webSocketClose never fires and armTtlAlarm
    // no-ops without createdAt). A tool call would launch it anyway.
    // Deliberately not awaited: consent must answer without waiting on Chromium.
    if (this.ctx.getWebSockets().length > 0) {
      void this.ensureBrowser().catch(() => {
        /* sendState already reports the failure to the page */
      });
    }
    return { ok: true };
  }

  async listAudit(): Promise<AuditRow[]> {
    return toAuditRows(
      this.ctx.storage.sql
        .exec<StoredAuditRow>(
          `SELECT origin, tool, field_names, ts FROM audit ORDER BY ts DESC LIMIT 50`,
        )
        .toArray(),
    );
  }

  /**
   * The account's log, which outlives this session. Falls back to the
   * session's own rows when there is no account — an unclaimed session is
   * still a working session.
   */
  async listHistory(): Promise<AuditRow[]> {
    const id = this.accountId();
    if (!id) return this.listAudit();
    return this.env.ACCOUNT.getByName(id).listAudit();
  }

  /**
   * Public RPC for the MCP server. Returns the tools this session exposes,
   * filtered by consent. SPINE is always present; per-origin manifests only
   * for granted origins.
   */
  async listTools(): Promise<ToolSchema[]> {
    const consented = new Set(this.readConsent());
    return (await buildToolList(consented, this.env.MANIFEST_REGISTRY)) as unknown as ToolSchema[];
  }

  /**
   * Public RPC for the MCP server. Bridges to the same runTool the WebMCP
   * façade calls via the bridge WebSocket. Same consent gate, same SSRF
   * check, same audit row. The only difference: no broadcast (MCP has no
   * socket), so we record the audit and return directly.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    const startedAt = Date.now();
    const manifest = await manifestFor(name, this.env.MANIFEST_REGISTRY);
    // The MCP entry, and only this one, strips caller-supplied profile paths.
    // Otherwise a client could pass {"address.line1": "…"} and route around
    // the approval — and the audit row would name a field that was never the
    // user's profile. The façade path merges *after* its own approve, so it is
    // deliberately left alone.
    const safeArgs = stripProfilePaths(manifest?.fillsFrom, args);
    let result: { ok: boolean; text: string; resolved?: string[] };
    try {
      result = await this.runTool(name, safeArgs);
    } catch (err) {
      result = {
        ok: false,
        text: err instanceof Error ? err.message : "tool failed",
      };
    }
    const auditOrigin = manifest?.origin ?? this.currentOrigin() ?? "";
    this.recordAudit(auditOrigin, name, result.resolved ?? []);
    this.recordSiteCall(manifest, result, Date.now() - startedAt);
    return { ok: result.ok, text: result.text };
  }

  /**
   * What agents did to this site's tools, for the site's owner.
   *
   * A different record from the audit row written beside it, kept in a
   * different place on purpose: the audit row is this person's account of
   * which of their fields travelled, and this is the merchant's account of how
   * their tool behaved for everyone. Nothing here identifies the caller, and
   * the tool is named as the *site* knows it, not as we qualify it.
   *
   * Not awaited: telemetry must never be in the path of a tool result.
   */
  private recordSiteCall(
    manifest: { origin: string; nativeName?: string; name: string } | null | undefined,
    result: { ok: boolean; reason?: string },
    ms: number,
  ): void {
    if (!manifest) return;
    this.ctx.waitUntil(
      this.env.SITE.getByName(manifest.origin).recordCall(
        manifest.nativeName ?? manifest.name,
        result.ok,
        result.ok ? null : (result.reason ?? "failed"),
        ms,
      ),
    );
  }

  async destroy(): Promise<void> {
    await this.teardownBrowser();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(1000, "destroyed");
    }
  }

  /**
   * Releases the browser when the session expires or when nobody is watching.
   * Without this a Browser Rendering session outlived every page that opened it.
   */
  async alarm(): Promise<void> {
    if (this.expired()) {
      await this.teardownBrowser();
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, "expired");
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      await this.teardownBrowser();
      return;
    }
    await this.armTtlAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const msg = parseClientMessage(message);
    if (!msg) {
      this.send(ws, { v: 1, type: "error", message: "bad envelope" });
      return;
    }
    switch (msg.type) {
      case "ping":
        this.send(ws, { v: 1, type: "pong" });
        return;
      case "screencast":
        // Toggles an existing stream. It never launches a browser.
        await this.setScreencast(msg.on);
        return;
      case "chat":
        await this.onChat(msg.content, msg.tools);
        return;
      case "tool_exec":
        await this.onToolExec(msg.id, msg.name, msg.arguments);
        return;
      case "approval_result":
        this.approvals.settle(msg.id, msg.ok, msg.fills);
        return;
      case "tool_result":
        await this.onToolResult(msg.callId, msg.ok, msg.result);
        return;
      case "input":
        await this.onInput(msg);
        return;
      case "autonomous":
        await this.setAutonomous(msg.on);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    // Nobody left who could answer. Settle now rather than making each
    // suspended call sit out its 45 seconds. A façade socket closing does not
    // count — it was never going to answer.
    if (this.ctx.getWebSockets("console").every((s) => s === ws)) {
      this.approvals.abandonAll();
    }
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length > 0) return;
    // Grace, not immediate teardown: a refresh must not cost the user the
    // login they just completed inside the viewport.
    const at = this.createdAt();
    const deadline = at ? at + SESSION_TTL_MS : Date.now() + IDLE_GRACE_MS;
    await this.ctx.storage.setAlarm(
      Math.min(Date.now() + IDLE_GRACE_MS, deadline),
    );
  }

  private async acceptBridge(request: Request): Promise<Response> {
    if (!this.createdAt()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('createdAt', ?)
         ON CONFLICT(key) DO NOTHING`,
        String(Date.now()),
      );
    }
    if (this.expired()) {
      return new Response("session expired", { status: 410 });
    }
    const role = parseBridgeRole(request.url);
    // Replace only a socket of the same role. A console and a façade are two
    // views of one session and must coexist — the agent is on the façade while
    // the human watches and approves on the console. Closing all of them, as
    // this did when there was only one view, would mean opening the console
    // disconnected the agent.
    for (const existing of this.ctx.getWebSockets(role)) {
      existing.close(4000, "replaced");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Tagged at accept time so `getWebSockets("console")` can find the human.
    this.ctx.acceptWebSocket(server, [role]);
    await this.armTtlAlarm();
    this.send(server, {
      v: 1,
      type: "state",
      origin: this.currentOrigin(),
      driving: this.driving,
      browser: this.browserState(),
    });
    void this.listAudit()
      .then((rows) => this.send(server, { v: 1, type: "audit", rows }))
      .catch(() => {
        /* the socket went away before the backlog landed */
      });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async onChat(content: string, tools: ToolSchema[]): Promise<void> {
    if (modelPath(this.env) === "none") {
      this.broadcast({ v: 1, type: "error", message: noModelMessage() });
      return;
    }
    this.pending = {
      messages: initialMessages(content),
      tools,
      waitingId: null,
    };
    await this.stepAgent();
  }

  private async stepAgent(): Promise<void> {
    const pending = this.pending;
    if (!pending || modelPath(this.env) === "none") return;
    let decision;
    try {
      decision = await runTurn(this.env, pending.messages, pending.tools);
    } catch (err) {
      this.pending = null;
      this.broadcast({
        v: 1,
        type: "error",
        message: err instanceof Error ? err.message : "agent failed",
      });
      return;
    }
    if (decision.kind === "message") {
      this.pending = null;
      this.broadcast({ v: 1, type: "assistant", content: decision.content });
      return;
    }
    pending.waitingId = decision.id;
    pending.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: decision.id,
          type: "function",
          function: {
            name: decision.name,
            arguments: JSON.stringify(decision.arguments),
          },
        },
      ],
    });
    this.broadcast({
      v: 1,
      type: "tool_call",
      id: decision.id,
      name: decision.name,
      arguments: decision.arguments,
    });
  }

  private async onToolExec(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    this.driving = true;
    this.sendState();
    const startedAt = Date.now();
    let result: { ok: boolean; text: string; resolved?: string[]; reason?: string };
    try {
      result = await this.runTool(name, args);
    } catch (err) {
      result = {
        ok: false,
        text: err instanceof Error ? err.message : "tool failed",
      };
    }
    this.driving = false;
    this.sendState();
    // Correlates with the page's bridge.exec promise only. The agent turn is
    // resumed by `tool_result`, which carries OpenAI's own tool-call id.
    this.broadcast({
      v: 1,
      type: "tool_exec_result",
      id,
      ok: result.ok,
      result: result.text,
    });
    const manifest = await manifestFor(name, this.env.MANIFEST_REGISTRY);
    // What moved, not what was declared. See runTool's `resolved`.
    this.recordAudit(
      manifest?.origin ?? this.currentOrigin() ?? "",
      name,
      result.resolved ?? [],
    );
    this.recordSiteCall(manifest, result, Date.now() - startedAt);
  }

  /**
   * One in-page agent turn is finished. The page sends this on every exit path,
   * including approval denied and executeTool throwing, so a turn cannot strand
   * with the chat box disabled.
   */
  private async onToolResult(
    callId: string,
    ok: boolean,
    result: string,
  ): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.waitingId !== callId) {
      this.broadcast({
        v: 1,
        type: "error",
        message: "no agent turn was waiting on that tool result",
      });
      return;
    }
    pending.messages = appendToolResult(
      pending.messages,
      callId,
      ok ? result : `error: ${result}`,
    );
    pending.waitingId = null;
    await this.stepAgent();
  }

  /**
   * `resolved` names the profile fields that actually moved on this call —
   * which is what the audit row records. The manifest's `fillsFrom` is a
   * declaration, not an event, and logging the declaration overcounts.
   */
  private async runTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    text: string;
    resolved?: string[];
    /** Failure class for site telemetry. Never a value or an argument. */
    reason?: string;
  }> {
    if (name === "list_available_origins") {
      return {
        ok: true,
        text: JSON.stringify({
          consented: this.readConsent(),
          known: MANIFESTS.map((m) => m.origin),
        }),
      };
    }
    if (name === "get_page_state") {
      // Reports on the browser; never starts one. This tool is registered before
      // any consent, so launching here would undo the consent-gated launch.
      const live = this.live;
      if (!live) {
        return {
          ok: true,
          text: this.env.BROWSER
            ? "No remote browser yet. Grant an origin (or call navigate_to on a granted one) and one starts."
            : "No Browser Rendering binding in this environment. Tools still register; they run when a live browser can open the site.",
        };
      }
      const url = live.page.url();
      const title = await live.page.title();
      let body = "";
      try {
        body = (await live.page.innerText("body")).slice(0, 4000);
      } catch {
        body = "";
      }
      this.setCurrentOrigin(originFromUrl(url));
      return { ok: true, text: `URL: ${url}\nTitle: ${title}\n\n${body}` };
    }
    if (name === "get_page_errors") {
      // Reports on the browser; never starts one, same rule as get_page_state.
      const entries = this.pageErrors.all();
      // An empty buffer means three different things, and reporting a clean
      // page for any of the other two tells the operator the opposite of the
      // truth — the failure mode this tool exists to close.
      if (entries.length === 0) {
        if (!this.live) {
          return {
            ok: true,
            text: this.env.BROWSER
              ? "No remote browser yet, so nothing has been recorded."
              : "No Browser Rendering binding in this environment, so no page errors are captured.",
          };
        }
        if (!this.pageErrorsAttached) {
          return {
            ok: true,
            text: "This browser does not report page events, so no errors are being captured. An empty result here is not a clean page.",
          };
        }
      }
      return { ok: true, text: describePageErrors(entries) };
    }
    if (name === "list_remote_tools") {
      // Reports on the page that is open; never starts a browser, same rule as
      // get_page_state.
      const live = this.live;
      if (!live) {
        // "Grant an origin first" was wrong and cost real debugging time: the
        // origin can be granted and this still fires, because consent does not
        // open a page. Name the thing that actually unblocks it.
        return {
          ok: true,
          text: "No remote page open yet. Call navigate_to with a granted origin first.",
        };
      }
      if (!live.page.evaluate) {
        return { ok: false, text: "cannot inspect the remote page" };
      }
      const url = live.page.url();
      const found = await discoverNativeTools(
        live.page.evaluate.bind(live.page) as DiscoverFn,
      );
      if (live.page.url() === url) {
        this.remoteToolsOrigin = originFromUrl(url);
        this.remoteTools = found.ok ? found.tools ?? [] : [];
        this.sendState();
      }
      if (!found.ok) {
        return {
          ok: true,
          text:
            found.reason === "threw"
              ? `Could not read tools on ${url}: ${found.error ?? "unknown error"}`
              : `${url} exposes no WebMCP tools. A tool for this origin would have to be synthesised.`,
        };
      }
      const tools = found.tools ?? [];
      if (tools.length === 0) {
        // modelContext is always present because we install it, so an empty
        // list means the site registered nothing -- not that WebMCP is absent.
        return {
          ok: true,
          text: `${url} registered no WebMCP tools of its own. A tool for this origin would have to be synthesised.`,
        };
      }
      const how = found.polyfilled
        ? " (WebMCP supplied by this session; the tools are the site's own)"
        : "";
      return {
        ok: true,
        text:
          `${url} exposes ${tools.length} WebMCP tool${tools.length === 1 ? "" : "s"} of its own${how}. ` +
          `Each is also registered on this page as <name>_on_${originSlug(originFromUrl(url))} for ChatGPT.\n` +
          tools
            .map(
              (t) =>
                `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.inputSchema)}`,
            )
            .join("\n"),
      };
    }
    if (name === "call_remote_tool") {
      const parsed = parseCallRemoteArgs(args);
      if (!parsed.ok) return { ok: false, text: parsed.text };
      const target = parsed.origin ?? "";
      if (target && !(await this.allowOrigin(originFromUrl(target)))) {
        return { ok: false, text: "origin not consented" };
      }
      const live = target ? await this.ensureBrowser() : this.live;
      if (!live) {
        return { ok: false, text: "No remote page open yet. Grant an origin first." };
      }
      if (!live.page.evaluate) {
        return { ok: false, text: `cannot reach ${parsed.name} on the remote page` };
      }
      if (target && originFromUrl(live.page.url()) !== originFromUrl(target)) {
        const blocked = await isPrivateUrl(target, makeResolve4());
        if (blocked) return { ok: false, text: "navigation refused (ssrf)" };
        const stable = await navigationStable(target, makeResolve4Records());
        if (!stable.ok) return { ok: false, text: "navigation refused (ssrf)" };
        await live.page.goto(target, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        this.setCurrentOrigin(originFromUrl(target));
      }
      const origin = originFromUrl(live.page.url());
      if (!(await this.allowOrigin(origin))) {
        return { ok: false, text: "origin not consented" };
      }
      const native = await callNativeTool(
        live.page.evaluate.bind(live.page) as EvaluateFn,
        parsed.name,
        parsed.arguments,
      );
      if (!native.used) {
        return { ok: false, text: nativeFailure(parsed.name, origin, native) };
      }
      return { ok: true, text: native.text ?? `ran ${origin}'s own ${parsed.name}` };
    }
    if (name === "navigate_to") {
      const target = String(args.origin ?? args.url ?? "");
      const blocked = await isPrivateUrl(target, makeResolve4());
      if (blocked) return { ok: false, text: "navigation refused (ssrf)" };
      const stable = await navigationStable(target, makeResolve4Records());
      if (!stable.ok) return { ok: false, text: "navigation refused (ssrf)" };
      const dest = originFromUrl(target);
      if (!(await this.allowOrigin(dest))) {
        return { ok: false, text: "origin not consented" };
      }
      const live = await this.ensureBrowser();
      if (!live) return { ok: false, text: "no browser" };
      await live.page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      this.setCurrentOrigin(originFromUrl(target));
      void this.refreshRemoteTools(live);
      return { ok: true, text: `navigated to ${live.page.url()}` };
    }

    if (name === "check_approval") {
      const id = String(args.id ?? "");
      const stored = this.readApprovalResult(id);
      if (stored) return stored;
      // No result yet is not the same as no such approval, but from here they
      // look alike: an id we never issued and one still waiting both have
      // nothing filed. Say what the caller can act on.
      return {
        ok: false,
        text: `approval ${id || "(none given)"} has no result yet — it is still waiting, or it expired.`,
      };
    }

    const manifest = await manifestFor(name, this.env.MANIFEST_REGISTRY);
    if (!manifest) return { ok: false, text: `unknown tool ${name}` };
    if (!(await this.allowOrigin(manifest.origin))) {
      return { ok: false, text: "origin not consented" };
    }
    // Ask before driving anything. A call nobody can approve should not cost a
    // Chromium launch, and a tool that cannot fill must say so rather than
    // filling blanks and reporting success.
    const declared = manifest.fillsFrom ?? [];
    const supplied = declared.filter((path) => args[path] !== undefined);
    const missing = missingFills(manifest.fillsFrom, args);
    if (!missing.length) {
      return this.executeManifest(manifest, name, args, supplied);
    }
    const ask = { origin: manifest.origin, tool: name, fieldNames: missing };
    const bounded = await this.approvals.requestBounded(
      ask,
      INLINE_APPROVAL_MS,
      // Answered after the caller stopped waiting. Run the work now and file
      // the result under the id so check_approval can return it. The fills
      // exist only inside this closure, same as on the inline path.
      async (late, id) => {
        let result: ToolResult;
        try {
          result = late.ok
            ? await this.executeManifest(
                manifest,
                name,
                { ...args, ...late.fills },
                [...supplied, ...Object.keys(late.fills)],
              )
            : { ok: false, text: approvalFailureText(late.reason, missing) };
        } catch (err) {
          result = {
            ok: false,
            text: err instanceof Error ? err.message : "tool failed",
          };
        }
        this.storeApprovalResult(id, result);
        this.recordAudit(manifest.origin, name, result.resolved ?? []);
        this.recordSiteCall(manifest, result, 0);
      },
    );
    if (bounded.status === "approved") {
      return this.executeManifest(
        manifest,
        name,
        { ...args, ...bounded.fills },
        [...supplied, ...Object.keys(bounded.fills)],
      );
    }
    if (bounded.status === "pending") {
      // Not a failure -- a receipt. The human has not answered yet, and
      // holding the caller open is what orphaned calls when the Durable
      // Object reset underneath them.
      return {
        ok: false,
        text: `approval-pending: waiting for a human to approve ${missing.join(", ")}. Call check_approval with id ${bounded.id}.`,
        reason: "approval-pending",
      };
    }
    return {
      ok: false,
      text: approvalFailureText(
        bounded.status === "denied" ? "denied" : "needs-console",
        missing,
      ),
      reason: bounded.status,
    };
  }

  /**
   * Everything after the human has (or has not) been asked.
   *
   * Extracted so the inline path and the late continuation run exactly the
   * same code: a call approved after the caller gave up must not take a
   * different route through the browser than one approved while it waited.
   */
  private async executeManifest(
    manifest: ToolManifest,
    name: string,
    callArgs: Record<string, unknown>,
    resolved: string[],
  ): Promise<ToolResult> {
    const live = await this.ensureBrowser();
    if (!live) return { ok: false, text: "no browser" };
    if (originFromUrl(live.page.url()) !== manifest.origin) {
      const blocked = await isPrivateUrl(manifest.origin, makeResolve4());
      if (blocked) return { ok: false, text: "navigation refused (ssrf)" };
      const stable = await navigationStable(manifest.origin, makeResolve4Records());
      if (!stable.ok) return { ok: false, text: "navigation refused (ssrf)" };
      await live.page.goto(manifest.origin, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    if (manifest.nativeName) {
      if (!live.page.evaluate) {
        return { ok: false, text: `cannot reach ${manifest.nativeName} on ${manifest.origin}` };
      }
      const native = await callNativeTool(
        live.page.evaluate.bind(live.page),
        manifest.nativeName,
        callArgs,
        // The tool's own schema, if we have observed this origin. Lets a call
        // that cannot satisfy it be classified rather than thrown — the one
        // fact a site owner can act on.
        this.declaredSchemaFor(manifest.origin, manifest.nativeName),
      );
      // A manifest with a nativeName proxies the store's own tool. If that tool
      // is not there, say so — empty steps must not report a fake success. And
      // say *which* of the three failures it was.
      if (!native.used) {
        return {
          ok: false,
          text: nativeFailure(manifest.nativeName, manifest.origin, native),
          reason: native.reason,
        };
      }
      this.setCurrentOrigin(manifest.origin);
      const how = native.polyfilled
        ? `${manifest.origin}'s own ${manifest.nativeName} (WebMCP supplied by this session)`
        : `${manifest.origin}'s own ${manifest.nativeName} (native WebMCP)`;
      return { ok: true, text: native.text ?? `ran ${how}`, resolved };
    }
    const { fillsAttempted, fillsLanded } = await runSteps(
      live.page,
      manifest.steps,
      callArgs,
      (url) => this.gotoGuarded(live, url),
    );
    this.setCurrentOrigin(manifest.origin);
    // The failure this whole design exists to remove: six fields typed into a
    // page that has none of them, reported as a success. A fill tool that
    // filled nothing did nothing, and the human is owed that sentence.
    if (fillsAttempted > 0 && fillsLanded === 0) {
      return {
        ok: false,
        text: `${name} found none of its fields on ${live.page.url()} — nothing was filled. Open the page that has the form first.`,
        reason: "no-field",
        resolved,
      };
    }
    const partial =
      fillsLanded < fillsAttempted
        ? ` (filled ${fillsLanded} of ${fillsAttempted} fields)`
        : "";
    return { ok: true, text: `ran ${name} at ${live.page.url()}${partial}`, resolved };
  }

  /** The one step that leaves the page it is on, so the one that needs the guard. */
  private async gotoGuarded(live: LiveBrowser, url: string): Promise<void> {
    const blocked = await isPrivateUrl(url, makeResolve4());
    if (blocked) throw new Error("navigation refused (ssrf)");
    const stable = await navigationStable(url, makeResolve4Records());
    if (!stable.ok) throw new Error("navigation refused (ssrf)");
    await live.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  private async onInput(msg: ClientMessage & { type: "input" }): Promise<void> {
    if (this.driving) return;
    const live = this.live;
    if (!live?.cdp) return;
    if (msg.kind === "mouse") {
      const x = Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(msg.x)));
      const y = Math.max(0, Math.min(VIEWPORT.height - 1, Math.round(msg.y)));
      const type =
        msg.action === "moved"
          ? "mouseMoved"
          : msg.action === "pressed"
            ? "mousePressed"
            : msg.action === "released"
              ? "mouseReleased"
              : "mouseWheel";
      await dispatchMouse(live.cdp, {
        type,
        x,
        y,
        button: msg.button === 2 ? "right" : "left",
        clickCount: msg.action === "pressed" ? 1 : undefined,
        deltaX: msg.deltaX,
        deltaY: msg.deltaY,
      });
      return;
    }
    if (msg.action === "insert" && msg.text) {
      await dispatchKey(live.cdp, { type: "char", text: msg.text });
      return;
    }
    await dispatchKey(live.cdp, {
      type: msg.action === "down" ? "keyDown" : "keyUp",
      key: msg.key,
    });
  }

  private async setScreencast(on: boolean): Promise<void> {
    const cdp = this.live?.cdp;
    if (cdp) {
      try {
        if (on) await resumeScreencast(cdp);
        else await stopScreencast(cdp);
      } catch {
        /* the session went away underneath us */
      }
    }
    this.sendState();
  }

  private async ensureBrowser(): Promise<LiveBrowser | null> {
    if (this.live) return this.live;
    if (!this.env.BROWSER) return null;
    // Consent and the first tool call can race; only one Chromium per session.
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const { launch } = await import("@cloudflare/playwright");
      const browser = await launch(this.env.BROWSER!, { recording: false });
      const page = await browser.newPage();
      await page.setViewportSize?.(VIEWPORT);
      // Before any page script, on every document: give the remote browser the
      // WebMCP API it lacks, so a storefront's own script has something to
      // register its own tools on. See inject-webmcp.ts.
      try {
        await page.addInitScript?.({ content: WEBMCP_POLYFILL });
      } catch {
        /* older binding without addInitScript; native path will report why */
      }
      // Subscribe before the first navigation, or the errors of the page that
      // navigation loads are missed. A binding without page.on captures
      // nothing and says so through get_page_errors rather than failing here.
      // Clear first: this browser must not inherit a torn-down one's errors.
      this.pageErrors.clear();
      this.pageErrorsAttached = attachPageErrorCapture(
        page as PageEventSource,
        this.pageErrors,
      );
      let cdp: CdpSession | null = null;
      try {
        cdp = wrapCdp(await page.context().newCDPSession(page));
        await startScreencast(cdp, (frame) => {
          this.broadcast({
            v: 1,
            type: "frame",
            jpeg: frame.data,
            width: frame.metadata?.deviceWidth ?? VIEWPORT.width,
            height: frame.metadata?.deviceHeight ?? VIEWPORT.height,
            sessionId: frame.sessionId,
          });
        });
      } catch {
        cdp = null;
      }
      this.live = { browser, page, cdp } as LiveBrowser;
      this.sendState();
      return this.live;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async teardownBrowser(): Promise<void> {
    const live = this.live;
    this.live = null;
    if (!live) return;
    if (live.cdp) {
      try {
        await stopScreencast(live.cdp);
      } catch {
        /* ignore */
      }
    }
    try {
      await live.browser.close();
    } catch {
      /* ignore */
    }
    this.sendState();
  }

  private async armTtlAlarm(): Promise<void> {
    const at = this.createdAt();
    if (!at) return;
    await this.ctx.storage.setAlarm(at + SESSION_TTL_MS);
  }

  private recordAudit(origin: string, tool: string, fieldNames: string[]): void {
    const ts = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO audit (origin, tool, field_names, ts) VALUES (?, ?, ?, ?)`,
      origin,
      tool,
      JSON.stringify(fieldNames),
      ts,
    );
    // Mirror to the account so the row outlives this session. Same reasoning
    // as consent: the local table stays the read path the broadcast uses, and
    // the durable copy is what a new session — or per-origin telemetry — can
    // still see tomorrow.
    const accountId = this.accountId();
    if (accountId) {
      this.ctx.waitUntil(
        this.env.ACCOUNT.getByName(accountId).recordAudit(
          origin,
          tool,
          fieldNames,
          ts,
        ),
      );
    }
    void this.listAudit()
      .then((rows) => this.broadcast({ v: 1, type: "audit", rows }))
      .catch(() => {
        /* audit is advisory; the row is already written */
      });
  }

  private consented(origin: string): boolean {
    return this.readConsent().includes(origin);
  }

  private readAutonomous(): boolean {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'autonomous' LIMIT 1`,
      )
      .toArray()[0];
    return row?.value === "1";
  }

  private async allowOrigin(origin: string): Promise<boolean> {
    if (!origin) return false;
    if (this.consented(origin)) return true;
    if (!this.readAutonomous()) return false;
    await this.grantConsent(origin);
    return this.consented(origin);
  }

  private async setAutonomous(on: boolean): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('autonomous', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      on ? "1" : "0",
    );
    if (on) {
      const catalog = [...new Set(MANIFESTS.map((m) => m.origin))];
      const merged = mergeAutonomousConsent(this.readConsent(), catalog);
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('consent', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify(merged),
      );
    }
    this.sendState();
  }

  private currentOrigin(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'origin' LIMIT 1`)
      .toArray()[0];
    return row?.value ?? null;
  }

  private setCurrentOrigin(origin: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('origin', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      origin,
    );
  }

  private createdAt(): number | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'createdAt' LIMIT 1`)
      .toArray()[0];
    return row ? Number(row.value) : null;
  }

  private expired(): boolean {
    const at = this.createdAt();
    if (!at) return false;
    return Date.now() - at > SESSION_TTL_MS;
  }

  private browserState(): BrowserState {
    if (this.live) return "live";
    return this.env.BROWSER ? "idle" : "missing";
  }

  /** The observed schema for a remote tool, when the page we read is its own. */
  private declaredSchemaFor(origin: string, nativeName: string): unknown {
    if (this.remoteToolsOrigin !== origin) return undefined;
    return this.remoteTools.find((t) => t.name === nativeName)?.inputSchema;
  }

  private async refreshRemoteTools(live: LiveBrowser): Promise<void> {
    if (!live.page.evaluate) {
      this.remoteTools = [];
      this.sendState();
      return;
    }
    const url = live.page.url();
    const found = await discoverNativeTools(
      live.page.evaluate.bind(live.page) as DiscoverFn,
    );
    if (live.page.url() !== url) return;
    this.remoteToolsOrigin = originFromUrl(url);
    this.remoteTools = found.ok ? found.tools ?? [] : [];
    this.sendState();
  }

  private sendState(): void {
    const origin = this.currentOrigin();
    let pageUrl: string | null = origin;
    try {
      pageUrl = this.live?.page.url() ?? origin;
    } catch {
      pageUrl = origin;
    }
    this.broadcast({
      v: 1,
      type: "state",
      origin,
      url: pageUrl,
      driving: this.driving,
      browser: this.browserState(),
      remoteTools:
        origin && origin === this.remoteToolsOrigin ? this.remoteTools : [],
      consented: this.readConsent(),
      autonomous: this.readAutonomous(),
    });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* closed */
      }
    }
  }
}

function nativeFailure(
  nativeName: string,
  origin: string,
  outcome: { reason?: string; error?: string },
): string {
  if (outcome.reason === "threw") {
    return `${nativeName} on ${origin} failed: ${outcome.error ?? "unknown error"}`;
  }
  if (outcome.reason === "no-webmcp") {
    return `${origin} exposes no document.modelContext on this page`;
  }
  if (outcome.reason === "schema-mismatch") {
    return `${nativeName} on ${origin} declares a schema these arguments cannot satisfy: ${outcome.error ?? "unknown"}`;
  }
  return `${nativeName} is not registered on ${origin} right now`;
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
