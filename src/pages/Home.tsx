import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { STORES } from "../../shared/stores";

export function Home() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="home">
      <div className="home__top">
        <p className="eyebrow">webmcp session</p>
        <ThemeToggle />
      </div>
      <h1>mcpmatic</h1>
      <p className="lede">
        One conversation, many origins. Shopify stores already speak WebMCP —
        we proxy those tools, origin-qualified. Sites that have none get a
        façade. Your profile never uploads wholesale; a call takes only the
        fields it named.
      </p>
      <p className="muted">
        ChatGPT’s tools are per-page. Shopify’s tools live on the storefront.
        This page is the session that spans merchants without replacing either.
      </p>
      <button
        type="button"
        className="primary home__go"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/sessions", { method: "POST" });
            if (!res.ok) throw new Error(`session failed (${res.status})`);
            const body = (await res.json()) as { sessionToken: string };
            nav(`/s/${body.sessionToken}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : "failed");
            setBusy(false);
          }
        }}
      >
        {busy ? "Opening…" : "Open a session"}
      </button>
      {error ? <p className="error">{error}</p> : null}

      <section className="use-cases" aria-label="Demo origins">
        {STORES.map((store) => (
          <article key={store.origin} className="use-case">
            <span className="badge">
              {store.kind === "shopify-webmcp" ? "Shopify native" : "Façade"}
            </span>
            <h2>{store.label}</h2>
            <p className="muted">{store.blurb}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
