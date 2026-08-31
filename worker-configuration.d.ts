/* Generated shape (wrangler types). SESSION is a typed stub of SessionDO. */
declare namespace Cloudflare {
  interface Env {
    SESSION: DurableObjectNamespace<import("./worker/session-do").SessionDO>;
    BROWSER?: Fetcher;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    ASSETS?: Fetcher;
  }
}
interface Env extends Cloudflare.Env {}
