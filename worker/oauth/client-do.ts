import type { OAuthClient } from "./types";

export class OAuthClientDO implements DurableObject {
  private state: DurableObjectState;
  private client: OAuthClient | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.client = (await this.state.storage.get<OAuthClient>("client")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/get" && request.method === "GET") {
      return this.client
        ? Response.json(this.client)
        : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json()) as OAuthClient;
      await this.state.storage.put("client", body);
      this.client = body;
      return Response.json(body);
    }
    if (url.pathname === "/revoke" && request.method === "POST") {
      await this.state.storage.deleteAll();
      this.client = null;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }
}
