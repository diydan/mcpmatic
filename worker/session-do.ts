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
import type { ManifestStep } from "../shared/manifest";
import { isPrivateUrl } from "./is-private-url";
import { makeResolve4 } from "./doh-resolve4";
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
import { MANIFESTS, manifestFor, originOfTool } from "./manifests";
import { buildToolList } from "./mcp/tools";
import {
  callNativeTool,
  discoverNativeTools,
  type DiscoverFn,
  type EvaluateFn,
} from "./native-webmcp";
import { WEBMCP_POLYFILL } from "./inject-webmcp";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
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
    fill?: (selector: string, value: string) => Promise<void>;
    click?: (selector: string) => Promise<void>;
    press?: (selector: string, key: string) => Promise<void>;
    waitForSelector?: (selector: string) => Promise<unknown>;
    evaluate?: EvaluateFn & DiscoverFn;
    context: () => {
      newCDPSession: (page: unknown) => Promise<CdpSession>;
    };
    setViewportSize?: (size: { width: number; height: number }) => Promise<void>;
    addInitScript?: (script: string | { content: string }) => Promise<void>;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(AUDIT_DDL);
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
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
  async listConsent(): Promise<{ consent: string[] }> {
    return { consent: this.readConsent() };
  }

  async grantConsent(origin: string): Promise<{ ok: true }> {
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
    const rows = this.ctx.storage.sql
      .exec<{ origin: string; tool: string; field_names: string; ts: number }>(
        `SELECT origin, tool, field_names, ts FROM audit ORDER BY ts DESC LIMIT 50`,
      )
      .toArray();
    return rows.map((r) => ({
      origin: r.origin,
      tool: r.tool,
      fieldNames: JSON.parse(r.field_names) as string[],
      timestamp: r.ts,
    }));
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
    let result: { ok: boolean; text: string };
    try {
      result = await this.runTool(name, args);
    } catch (err) {
      result = {
        ok: false,
        text: err instanceof Error ? err.message : "tool failed",
      };
    }
    const fieldNames = (await manifestFor(name, this.env.MANIFEST_REGISTRY))?.fillsFrom ?? [];
    const auditOrigin =
      (await originOfTool(name, this.env.MANIFEST_REGISTRY)) ?? this.currentOrigin() ?? "";
    this.recordAudit(auditOrigin, name, fieldNames);
    return result;
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
      case "tool_result":
        await this.onToolResult(msg.callId, msg.ok, msg.result);
        return;
      case "input":
        await this.onInput(msg);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
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

  private async acceptBridge(_request: Request): Promise<Response> {
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
    for (const existing of this.ctx.getWebSockets()) {
      existing.close(4000, "replaced");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
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
    let result: { ok: boolean; text: string };
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
    const fieldNames = (await manifestFor(name, this.env.MANIFEST_REGISTRY))?.fillsFrom ?? [];
    this.recordAudit(
      (await originOfTool(name, this.env.MANIFEST_REGISTRY)) ?? this.currentOrigin() ?? "",
      name,
      fieldNames,
    );
  }

  /**
   * One in-page agent turn is finished. The page sends this on every exit path,
   * including bless denied and executeTool throwing, so a turn cannot strand
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

  private async runTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
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
    if (name === "list_remote_tools") {
      // Reports on the page that is open; never starts a browser, same rule as
      // get_page_state.
      const live = this.live;
      if (!live) {
        return { ok: true, text: "No remote page open yet. Grant an origin first." };
      }
      if (!live.page.evaluate) {
        return { ok: false, text: "cannot inspect the remote page" };
      }
      const url = live.page.url();
      const found = await discoverNativeTools(
        live.page.evaluate.bind(live.page) as DiscoverFn,
      );
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
          `${url} exposes ${tools.length} WebMCP tool${tools.length === 1 ? "" : "s"} of its own${how}:\n` +
          tools.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
      };
    }
    if (name === "navigate_to") {
      const target = String(args.origin ?? args.url ?? "");
      const blocked = await isPrivateUrl(target, makeResolve4());
      if (blocked) return { ok: false, text: "navigation refused (ssrf)" };
      if (!this.consented(originFromUrl(target))) {
        return { ok: false, text: "origin not consented" };
      }
      const live = await this.ensureBrowser();
      if (!live) return { ok: false, text: "no browser" };
      await live.page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      this.setCurrentOrigin(originFromUrl(target));
      return { ok: true, text: `navigated to ${live.page.url()}` };
    }

    const manifest = await manifestFor(name, this.env.MANIFEST_REGISTRY);
    if (!manifest) return { ok: false, text: `unknown tool ${name}` };
    if (!this.consented(manifest.origin)) {
      return { ok: false, text: "origin not consented" };
    }
    const live = await this.ensureBrowser();
    if (!live) return { ok: false, text: "no browser" };
    if (originFromUrl(live.page.url()) !== manifest.origin) {
      const blocked = await isPrivateUrl(manifest.origin, makeResolve4());
      if (blocked) return { ok: false, text: "navigation refused (ssrf)" };
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
        args,
      );
      // A manifest with a nativeName proxies the store's own tool. If that tool
      // is not there, say so — empty steps must not report a fake success. And
      // say *which* of the three failures it was.
      if (!native.used) {
        return { ok: false, text: nativeFailure(manifest.nativeName, manifest.origin, native) };
      }
      this.setCurrentOrigin(manifest.origin);
      const how = native.polyfilled
        ? `${manifest.origin}'s own ${manifest.nativeName} (WebMCP supplied by this session)`
        : `${manifest.origin}'s own ${manifest.nativeName} (native WebMCP)`;
      return { ok: true, text: native.text ?? `ran ${how}` };
    }
    for (const step of manifest.steps) {
      await this.runStep(live, step, args);
    }
    this.setCurrentOrigin(manifest.origin);
    return { ok: true, text: `ran ${name} at ${live.page.url()}` };
  }

  private async runStep(
    live: LiveBrowser,
    step: ManifestStep,
    args: Record<string, unknown>,
  ): Promise<void> {
    const interpolate = (template: string) =>
      template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) =>
        encodeURIComponent(String(args[key] ?? "")),
      );

    if (step.action === "goto") {
      const url = interpolate(step.url);
      const blocked = await isPrivateUrl(url, makeResolve4());
      if (blocked) throw new Error("navigation refused (ssrf)");
      await live.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      return;
    }
    if (step.action === "fill" || step.action === "type") {
      const value = String(args[step.from] ?? "");
      try {
        await live.page.fill?.(step.selector, value);
      } catch {
        /* field missing on this checkout step */
      }
      return;
    }
    if (step.action === "click") {
      await live.page.click?.(step.selector);
      return;
    }
    if (step.action === "press") {
      await live.page.press?.(step.selector, step.key);
      return;
    }
    if (step.action === "wait") {
      await live.page.waitForSelector?.(step.selector);
    }
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
    this.ctx.storage.sql.exec(
      `INSERT INTO audit (origin, tool, field_names, ts) VALUES (?, ?, ?, ?)`,
      origin,
      tool,
      JSON.stringify(fieldNames),
      Date.now(),
    );
    void this.listAudit()
      .then((rows) => this.broadcast({ v: 1, type: "audit", rows }))
      .catch(() => {
        /* audit is advisory; the row is already written */
      });
  }

  private consented(origin: string): boolean {
    return this.readConsent().includes(origin);
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

  private sendState(): void {
    this.broadcast({
      v: 1,
      type: "state",
      origin: this.currentOrigin(),
      driving: this.driving,
      browser: this.browserState(),
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
  return `${nativeName} is not registered on ${origin} right now`;
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
