import { DurableObject } from "cloudflare:workers";
import {
  AUDIT_DDL,
  parseClientMessage,
  type AuditRow,
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
  startScreencast,
  wrapCdp,
  type CdpSession,
} from "./cdp";
import {
  appendToolResult,
  initialMessages,
  runTurn,
  type ChatTurn,
} from "./agent";
import { MANIFESTS, manifestFor, originOfTool } from "./manifests";
import { callNativeTool } from "./native-webmcp";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
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
    evaluate?: (
      fn: (payload: { nativeName: string; args: Record<string, unknown> }) => Promise<{
        used: boolean;
        text?: string;
      }>,
      payload: { nativeName: string; args: Record<string, unknown> },
    ) => Promise<{ used: boolean; text?: string }>;
    context: () => {
      newCDPSession: (page: unknown) => Promise<CdpSession>;
    };
    setViewportSize?: (size: { width: number; height: number }) => Promise<void>;
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
    return new Response("expected websocket", { status: 400 });
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

  async destroy(): Promise<void> {
    await this.teardownBrowser();
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(1000, "destroyed");
    }
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
        if (msg.on) await this.ensureBrowser();
        this.sendState();
        return;
      case "chat":
        await this.onChat(msg.content, msg.tools);
        return;
      case "tool_exec":
        await this.onToolExec(msg.id, msg.name, msg.arguments);
        return;
      case "input":
        await this.onInput(msg);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  private acceptBridge(_request: Request): Response {
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
    this.send(server, {
      v: 1,
      type: "state",
      origin: this.currentOrigin(),
      driving: false,
      browser: this.env.BROWSER ? "live" : "missing",
    });
    void this.listAudit().then((rows) =>
      this.send(server, { v: 1, type: "audit", rows }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  private async onChat(content: string, tools: ToolSchema[]): Promise<void> {
    const key = this.env.OPENAI_API_KEY;
    if (!key) {
      this.broadcast({
        v: 1,
        type: "error",
        message: "OPENAI_API_KEY is not set on the worker. The in-page agent cannot run. ChatGPT can still call the registered tools.",
      });
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
    const key = this.env.OPENAI_API_KEY;
    if (!pending || !key) return;
    const model = this.env.OPENAI_MODEL || "gpt-4.1";
    let decision;
    try {
      decision = await runTurn(key, model, pending.messages, pending.tools);
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
    this.broadcast({
      v: 1,
      type: "tool_exec_result",
      id,
      ok: result.ok,
      result: result.text,
    });
    const fieldNames = manifestFor(name)?.fillsFrom ?? [];
    this.recordAudit(originOfTool(name) ?? this.currentOrigin() ?? "", name, fieldNames);
    if (this.pending?.waitingId === id) {
      this.pending.messages = appendToolResult(
        this.pending.messages,
        id,
        result.text,
      );
      this.pending.waitingId = null;
      await this.stepAgent();
    }
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
      const live = await this.ensureBrowser();
      if (!live) {
        return { ok: true, text: "No remote browser in this environment. Tools still register; connect a Browser Rendering binding to drive a site." };
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

    const manifest = manifestFor(name);
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
    if (manifest.nativeName && live.page.evaluate) {
      const native = await callNativeTool(
        live.page.evaluate.bind(live.page),
        manifest.nativeName,
        args,
      );
      if (native.used) {
        this.setCurrentOrigin(manifest.origin);
        return {
          ok: true,
          text: native.text ?? `native ${manifest.nativeName} on ${manifest.origin}`,
        };
      }
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

  private async ensureBrowser(): Promise<LiveBrowser | null> {
    if (this.live) return this.live;
    if (!this.env.BROWSER) return null;
    const { launch } = await import("@cloudflare/playwright");
    const browser = await launch(this.env.BROWSER, { recording: false });
    const page = await browser.newPage();
    await page.setViewportSize?.(VIEWPORT);
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
  }

  private async teardownBrowser(): Promise<void> {
    const live = this.live;
    this.live = null;
    if (!live) return;
    try {
      await live.browser.close();
    } catch {
      /* ignore */
    }
  }

  private recordAudit(origin: string, tool: string, fieldNames: string[]): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO audit (origin, tool, field_names, ts) VALUES (?, ?, ?, ?)`,
      origin,
      tool,
      JSON.stringify(fieldNames),
      Date.now(),
    );
    void this.listAudit().then((rows) =>
      this.broadcast({ v: 1, type: "audit", rows }),
    );
  }

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

  private sendState(): void {
    this.broadcast({
      v: 1,
      type: "state",
      origin: this.currentOrigin(),
      driving: this.driving,
      browser: this.live ? "live" : this.env.BROWSER ? "live" : "missing",
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

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
