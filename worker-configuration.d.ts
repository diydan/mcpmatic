/* Generated shape (wrangler types). SESSION is a typed stub of SessionDO. */
declare namespace Cloudflare {
  interface Env {
    SESSION: DurableObjectNamespace<import("./worker/session-do").SessionDO>;
    BROWSER?: Fetcher;
    /**
     * AI binding. Typed as the subset we use so the model id can be any
     * `{author}/{model}` string, which the generated `Ai` union does not allow.
     */
    AI?: {
      run: (
        model: string,
        input: Record<string, unknown>,
        options?: { gateway?: { id: string } },
      ) => Promise<unknown>;
    };
    /** Optional: which AI Gateway to route through. Defaults to "default". */
    AI_GATEWAY_ID?: string;
    /** Fallback only, when there is no AI binding. */
    OPENAI_API_KEY?: string;
    /** Accepts "openai/gpt-5.5" or a bare "gpt-5.5". */
    OPENAI_MODEL?: string;
    ASSETS?: Fetcher;
  }
}
interface Env extends Cloudflare.Env {}
