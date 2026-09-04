import { useEffect, useState } from "react";
import type { StoreKind } from "../../shared/stores";
import { normaliseOrigin } from "../../shared/origin";
import {
  initialConsentUxState,
  reduceConsentUx,
  type ConsentFlag,
  type ConsentUxResult,
} from "../../shared/consent-ux";

type Props = {
  origins: Array<{ origin: string; label: string; kind: StoreKind }>;
  consented: ReadonlySet<string>;
  onGrant: (origin: string) => void;
  onRevoke: (origin: string) => void;
  autonomous: boolean;
  onAutonomous: (on: boolean) => void;
  autoGrantNew: boolean;
  onAutoGrantNew: (on: boolean) => void;
};

/**
 * Body the confirm modal shows when the user turns ON `autonomous`. Lists
 * the catalog so the prompt is concrete: "you are about to grant these
 * specific sites". `autoGrantNew` reuses the same text and adds a one-liner
 * about new sites as they appear.
 */
function buildConfirmBody(
  field: ConsentFlag,
  catalog: ReadonlyArray<{ origin: string; label: string }>,
): string {
  const list = catalog
    .map((o) => o.label || o.origin.replace(/^https:\/\//, ""))
    .join(", ");
  const head =
    field === "autonomous"
      ? `Turning this on grants the demo catalog: ${list}.`
      : `Turning this on grants the demo catalog: ${list}, and any new origin ChatGPT navigates to.`;
  return (
    head +
    " You still approve before any profile field leaves the page."
  );
}

/**
 * First-toggle gate. The modal is a "have you seen this?" prompt, not an
 * every-toggle prompt: once the user confirms for a given flag, subsequent
 * toggles commit immediately. The state lives in this component only — a
 * refresh resets the gate, which is the conservative choice for a UX that
 * is meant to remind, not to block repeat users. The state machine itself
 * lives in `shared/consent-ux.ts` so it can be tested without rendering.
 */
export function Consent({
  origins,
  consented,
  onGrant,
  onRevoke,
  autonomous,
  onAutonomous,
  autoGrantNew,
  onAutoGrantNew,
}: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ux, setUx] = useState<ConsentUxResult>(() => ({
    ...initialConsentUxState(),
    flags: { autonomous, autoGrantNew },
    showConfirm: null,
  }));

  /**
   * Sync incoming prop changes (server `state` broadcast, GET
   * `/s/<token>/consent` hydration) into the state machine. The user
   * can't toggle while the modal is open, so we don't need to preserve an
   * in-flight confirmation across a re-mount. Skipped when nothing
   * changed to avoid an extra render on every keystroke upstream.
   */
  useEffect(() => {
    setUx((u) =>
      u.flags.autonomous === autonomous && u.flags.autoGrantNew === autoGrantNew
        ? u
        : { ...u, flags: { autonomous, autoGrantNew } },
    );
  }, [autonomous, autoGrantNew]);

  const known = new Set(origins.map((o) => o.origin));
  // Origins the human typed in, shown so the grant list is the whole truth.
  const extra = [...consented].filter((o) => !known.has(o));

  const commit = (field: ConsentFlag, next: boolean) => {
    if (field === "autonomous") onAutonomous(next);
    else onAutoGrantNew(next);
  };

  const dispatch = (
    apply: (s: ConsentUxResult) => ReturnType<typeof reduceConsentUx>,
  ) => {
    setUx((u) => {
      const result = apply(u);
      // When the state machine says "show confirm", the flag is held until
      // the user decides. When it says "apply" (i.e. no modal), commit the
      // new flag value to the parent so it can persist and broadcast.
      if (!result.showConfirm) {
        for (const f of ["autonomous", "autoGrantNew"] as const) {
          if (result.flags[f] !== u.flags[f]) commit(f, result.flags[f]);
        }
      }
      return result;
    });
  };

  const onToggle = (field: ConsentFlag, next: boolean) =>
    dispatch((u) => reduceConsentUx(u, { kind: "toggle", field, next }));

  const onConfirm = () =>
    dispatch((u) =>
      u.showConfirm
        ? reduceConsentUx(u, { kind: "confirm", field: u.showConfirm })
        : u,
    );

  const onCancel = () => dispatch((u) => reduceConsentUx(u, { kind: "cancel" }));

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
        onClick={() => onToggle("autonomous", !autonomous)}
        data-testid="consent-switch-autonomous"
      >
        Auto-grant catalog
      </button>
      <p className="consent__note">
        {autonomous
          ? "On: every demo origin is granted. Approval still asks before profile fields leave."
          : "Off: grant each catalog origin yourself. Turn on to let ChatGPT move between demo sites without a grant click."}
      </p>
      <button
        type="button"
        className="consent__switch"
        role="switch"
        aria-checked={autoGrantNew}
        // Switching on `autoGrantNew` only makes sense when the catalog
        // grant is on — without autonomous, nothing auto-grants. Disable
        // the control so the user doesn't toggle it into a no-op state.
        disabled={!autonomous}
        onClick={() => onToggle("autoGrantNew", !autoGrantNew)}
        data-testid="consent-switch-auto-grant-new"
      >
        Auto-grant new origins
      </button>
      <p className="consent__note">
        {autoGrantNew
          ? "On: any new site ChatGPT navigates to is granted as it appears. The first time you turn this on, the catalog is listed for you to confirm."
          : "Off: catalog origins are auto-granted, but new sites need a manual grant. Turn on to let ChatGPT open new sites without a grant click."}
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
      {ux.showConfirm ? (
        <Confirm
          body={buildConfirmBody(ux.showConfirm, origins)}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </section>
  );
}

/**
 * Inline confirm modal — shown the first time the user turns ON either of
 * the consent switches. Inline (not a new file) keeps the surface area of
 * this review item to two components. Styled like `ApprovalDialog` rather
 * than the existing `consent__switch` so the prompt is unmistakably a
 * "are you sure" rather than just another toggle.
 */
type ConfirmProps = {
  body: string;
  onConfirm: () => void;
  onCancel: () => void;
};

function Confirm({ body, onConfirm, onCancel }: ConfirmProps) {
  return (
    <div
      className="approval"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-confirm-title"
      data-testid="consent-confirm"
    >
      <div className="approval__card">
        <h2 id="consent-confirm-title">confirm auto-grant</h2>
        <p>{body}</p>
        <div className="approval__actions">
          <button type="button" onClick={onCancel} data-testid="consent-confirm-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={onConfirm}
            data-testid="consent-confirm-ok"
          >
            Turn on
          </button>
        </div>
      </div>
    </div>
  );
}