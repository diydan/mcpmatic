import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "../components/Header";
import { ThemeToggle } from "../components/ThemeToggle";
import { getRecentSites, recordRecentSite, type RecentSite } from "../lib/recent-sites";

export function Home() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSites, setRecentSites] = useState<RecentSite[]>(() => getRecentSites());

  useEffect(() => {
    setRecentSites(getRecentSites());
  }, []);

  return (
    <main className="home">
      <div className="home__top">
        <ThemeToggle />
      </div>
      <h1>BrowserMatic</h1>
      <p className="lede">
        Let AI do the browsing for you: save hours, get the best deals across stores, book plans without tab-juggling, and auto-fill tedious forms in seconds.
      </p>
      <p className="muted">
        Enter any website URL or ask any browsing task to get started.
      </p>
      <div className="home__start">
        <Header
          placeholder="Search, ask a task, or enter a website..."
          submitLabel="Go"
          disabled={busy}
          error={error ?? undefined}
          onSubmit={async (input) => {
            setError(null);
            setBusy(true);

            // Check if input is a URL/domain or a natural language search/task query
            const trimmed = input.trim();
            const looksLikeUrl =
              /^https?:\/\//i.test(trimmed) ||
              /^[\w-]+\.[\w.-]+(\/.*)?$/i.test(trimmed);

            let origin: string | null = null;
            let initialPrompt: string | null = null;

            if (looksLikeUrl) {
              origin = trimmed;
              recordRecentSite(origin);
            } else {
              initialPrompt = trimmed;
            }

            try {
              const res = await fetch("/sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(origin ? { origin } : {}),
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
              const { sessionToken, origin: granted } = (await res.json()) as {
                sessionToken: string;
                origin?: string | null;
              };
              nav(`/c/${sessionToken}`, {
                state: {
                  origin: granted || origin || undefined,
                  initialPrompt: initialPrompt || undefined,
                },
              });
            } catch {
              setError("request failed");
            } finally {
              setBusy(false);
            }
          }}
        />
        <div className="home__prompts">
          <span className="home__prompts-label">Try asking:</span>
          <div className="home__chips">
            {[
              {
                icon: "🛒",
                text: "Find the best deal across 4 stores",
                origin: "https://www.allbirds.com",
              },
              {
                icon: "🍕",
                text: "Book dinner & movie tickets together",
                origin: "https://www.kayak.com",
              },
              {
                icon: "✈️",
                text: "Plan and price my trip in one shot",
                origin: "https://www.kayak.com",
              },
              {
                icon: "📋",
                text: "Auto-fill council forms & applications",
                origin: "https://www.gov.uk",
              },
            ].map((chip) => (
              <button
                key={chip.text}
                type="button"
                className="home__chip"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  setBusy(true);
                  try {
                    const res = await fetch("/sessions", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ origin: chip.origin }),
                    });
                    if (!res.ok) {
                      setError("request failed");
                      return;
                    }
                    const { sessionToken, origin: granted } =
                      (await res.json()) as {
                        sessionToken: string;
                        origin?: string | null;
                      };
                    nav(`/c/${sessionToken}`, {
                      state: {
                        origin: granted || chip.origin,
                        initialPrompt: chip.text,
                      },
                    });
                  } catch {
                    setError("request failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {chip.icon} "{chip.text}"
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="last-automated" aria-label="Last webpages automated">
        <h2 className="last-automated__title">Last webpages automated</h2>
        <ul className="last-automated__list">
          {recentSites.map((store) => (
            <li key={store.origin}>
              <button
                type="button"
                className="last-automated__item"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  setBusy(true);
                  recordRecentSite(store.origin, store.label, store.blurb);
                  try {
                    const res = await fetch("/sessions", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ origin: store.origin }),
                    });
                    if (!res.ok) {
                      setError("request failed");
                      return;
                    }
                    const { sessionToken, origin: granted } =
                      (await res.json()) as {
                        sessionToken: string;
                        origin?: string | null;
                      };
                    nav(`/c/${sessionToken}`, {
                      state: { origin: granted || store.origin },
                    });
                  } catch {
                    setError("request failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <div className="last-automated__meta">
                  <div className="last-automated__brand">
                    <img
                      className="last-automated__favicon"
                      src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(store.origin)}&size=32`}
                      alt=""
                      width={18}
                      height={18}
                      loading="eager"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <span className="last-automated__name">{store.label}</span>
                  </div>
                  <span className="badge">
                    {store.kind === "shopify-webmcp"
                      ? "Shopify native"
                      : store.label === "GOV.UK"
                        ? "Approve"
                        : "Façade"}
                  </span>
                </div>
                <p className="muted last-automated__blurb">{store.blurb}</p>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
