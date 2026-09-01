import type { AuthCode } from "./types";

export class OAuthCodeDO implements DurableObject {
  private state: DurableObjectState;
  private code: AuthCode | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.code = (await this.state.storage.get<AuthCode>("code")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/issue" && request.method === "POST") {
      const body = (await request.json()) as AuthCode;
      await this.state.storage.put("code", body);
      this.code = body;
      return Response.json({ code: body.code });
    }
    if (url.pathname === "/consume" && request.method === "POST") {
      if (!this.code) return new Response("invalid_grant", { status: 400 });
      if (this.code.used) return new Response("invalid_grant", { status: 400 });
      if (Date.now() > this.code.expiresAt) return new Response("invalid_grant", { status: 400 });
      this.code = { ...this.code, used: true };
      await this.state.storage.put("code", this.code);
      return Response.json(this.code);
    }
    return new Response("not found", { status: 404 });
  }
}