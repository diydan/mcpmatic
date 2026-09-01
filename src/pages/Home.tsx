import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
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
      <div className="home__start">
        <Header
          placeholder="https://example.com"
          submitLabel="Go"
          disabled={busy}
          error={error ?? undefined}
          onSubmit={async (origin) => {
            setError(null);
            setBusy(true);
            try {
              const res = await fetch("/sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ origin }),
              });
              if (!res.ok) {
                const { error: msg } = (await res
                  .json()
                  .catch(() => ({ error: "request failed" }))) as {
                  error?: string;
                };
                setError(msg || "request failed");
                return;
              }
              const { sessionToken } = (await res.json()) as {
                sessionToken: string;
              };
              nav(`/s/${sessionToken}`);
            } catch {
              setError("request failed");
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>

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
