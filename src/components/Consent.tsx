import type { StoreKind } from "../../shared/stores";

type Props = {
  origins: Array<{ origin: string; label: string; kind: StoreKind }>;
  consented: ReadonlySet<string>;
  onGrant: (origin: string) => void;
};

export function Consent({ origins, consented, onGrant }: Props) {
  return (
    <section className="consent" aria-label="Origin consent">
      <h2>grant an origin</h2>
      <p>
        ChatGPT is granted this page. Tools for another origin stay unregistered
        until you say so. Shopify stores keep their own WebMCP; we only proxy it.
      </p>
      <ul>
        {origins.map((o) => {
          const granted = consented.has(o.origin);
          return (
            <li key={o.origin}>
              <span className="badge">
                {o.kind === "shopify-webmcp" ? "Shopify" : "Façade"}
              </span>
              <span>{o.label}</span>
              <button
                type="button"
                disabled={granted}
                onClick={() => onGrant(o.origin)}
              >
                {granted ? "granted" : "grant"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
