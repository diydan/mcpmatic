import type { DiscoveredTool, ToolSchema } from "../../shared/protocol";
import { offersFor } from "../lib/offers";

type Props = {
  origin: string | null;
  remoteTools: DiscoveredTool[];
  registered: ToolSchema[];
  onOffer: (name: string) => void;
  onMapSite?: () => void;
  mapSiteBusy?: boolean;
};

export function Surface({
  origin,
  remoteTools,
  registered,
  onOffer,
  onMapSite,
  mapSiteBusy,
}: Props) {
  const offers = offersFor({ registered, origin });
  const host = origin ? origin.replace(/^https:\/\//, "") : null;

  return (
    <section className="surface" aria-label="On this page">
      <h2>on this page</h2>
      <p>
        You browse. ChatGPT can call the tools this origin registered — they
        show up as chips, origin-qualified.
      </p>
      {host ? (
        <p className="muted">{host}</p>
      ) : (
        <p className="muted">Grant an origin to open a page.</p>
      )}
      {remoteTools.length > 0 ? (
        <ul className="surface__tools">
          {remoteTools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              <span>{t.description}</span>
            </li>
          ))}
        </ul>
      ) : host ? (
        <div className="surface__no-tools">
          <p className="muted">
            No WebMCP tools on this page. Synthesised tools may still apply.
          </p>
          {onMapSite ? (
            <button type="button" disabled={!!mapSiteBusy} onClick={onMapSite}>
              {mapSiteBusy ? "mapping…" : "Map this site"}
            </button>
          ) : null}
        </div>
      ) : null}
      {offers.length > 0 ? (
        <ul className="surface__offers">
          {offers.map((o) => (
            <li key={o.name}>
              <button
                type="button"
                className="primary"
                onClick={() => onOffer(o.name)}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
