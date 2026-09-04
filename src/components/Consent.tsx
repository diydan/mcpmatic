import { useState } from "react";
import type { StoreKind } from "../../shared/stores";
import { normaliseOrigin } from "../../shared/origin";

type Props = {
  origins: Array<{ origin: string; label: string; kind: StoreKind }>;
  consented: ReadonlySet<string>;
  onGrant: (origin: string) => void;
  onRevoke: (origin: string) => void;
  autonomous: boolean;
  onAutonomous: (on: boolean) => void;
};

export function Consent({
  origins,
  consented,
  onGrant,
  onRevoke,
  autonomous,
  onAutonomous,
}: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const known = new Set(origins.map((o) => o.origin));
  // Origins the human typed in, shown so the grant list is the whole truth.
  const extra = [...consented].filter((o) => !known.has(o));

  return (
    <section className="consent" aria-label="Connected websites">
      <h2>Connected websites</h2>
      <p>
        Websites you allow AI to search and browse. You are always in control of which sites AI accesses.
      </p>
      <button
        type="button"
        className="consent__switch"
        role="switch"
        aria-checked={autonomous}
        onClick={() => onAutonomous(!autonomous)}
      >
        Auto-browse any site
      </button>
      <p className="consent__note">
        {autonomous
          ? "On: AI can freely explore across sites to compare options and find deals. Private personal details still require your approval."
          : "Off: AI only opens sites you have explicitly enabled below."}
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
                {granted ? "Enabled" : "Enable"}
              </button>
              {granted && (
                <button type="button" onClick={() => onRevoke(o.origin)}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
        {extra.map((o) => (
          <li key={o}>
            <span className="badge">Custom</span>
            <span>{o.replace(/^https:\/\//, "")}</span>
            <button type="button" onClick={() => onRevoke(o)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="consent__add"
        onSubmit={(e) => {
          e.preventDefault();
          const origin = normaliseOrigin(draft);
          if (!origin) {
            setError("Please enter a website, e.g. example.com");
            return;
          }
          if (consented.has(origin)) {
            setError(`${origin.replace(/^https:\/\//, "")} is already enabled`);
            return;
          }
          setError(null);
          setDraft("");
          onGrant(origin);
        }}
      >
        <label className="sr-only" htmlFor="consent-origin">
          Add any other website
        </label>
        <input
          id="consent-origin"
          value={draft}
          placeholder="Add any website (e.g. example.com)"
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      <p className="consent__note">
        {error ??
          "A site you add is inspected for WebMCP. ChatGPT gets those tools, origin-qualified."}
      </p>
    </section>
  );
}
