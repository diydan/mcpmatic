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
    <section className="surface" aria-label="Available page actions">
      <h2>Actions on this page</h2>
      <p>
        Actions the AI can perform directly on this website.
      </p>
      {host ? (
        <p className="muted">{host}</p>
      ) : (
        <p className="muted">Select or open a website to view available actions.</p>
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
            Standard browser automation available for this page.
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
