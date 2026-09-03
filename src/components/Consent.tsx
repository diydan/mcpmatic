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
    <section className="consent" aria-label="Origin consent">
      <h2>grant an origin</h2>
      <p>
        ChatGPT is granted this page. Tools for another origin stay unregistered
        until you say so. Shopify stores keep their own WebMCP; we only proxy it.
      </p>
      <button
        type="button"
        className="consent__switch"
        role="switch"
        aria-checked={autonomous}
        onClick={() => onAutonomous(!autonomous)}
      >
        Autonomous
      </button>
      <p className="consent__note">
        {autonomous
          ? "On: every demo origin is granted, and any site you or ChatGPT open is granted. Approval still asks before profile fields leave."
          : "Off: grant each origin yourself. Turn on to let ChatGPT move without a grant click."}
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
              {granted && (
                <button type="button" onClick={() => onRevoke(o.origin)}>
                  revoke
                </button>
              )}
            </li>
          );
        })}
        {extra.map((o) => (
          <li key={o}>
            <span className="badge">Yours</span>
            <span>{o.replace(/^https:\/\//, "")}</span>
            <button type="button" onClick={() => onRevoke(o)}>
              granted — revoke
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
            setError("Needs an https site, like allbirds.com");
            return;
          }
          if (consented.has(origin)) {
            setError(`${origin.replace(/^https:\/\//, "")} is already granted`);
            return;
          }
          setError(null);
          setDraft("");
          onGrant(origin);
        }}
      >
        <label className="sr-only" htmlFor="consent-origin">
          Any other site
        </label>
        <input
          id="consent-origin"
          value={draft}
          placeholder="or any site — example.com"
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
        />
        <button type="submit" disabled={!draft.trim()}>
          grant
        </button>
      </form>
      <p className="consent__note">
        {error ??
          "A site you add is inspected for WebMCP. ChatGPT gets those tools, origin-qualified."}
      </p>
    </section>
  );
}
