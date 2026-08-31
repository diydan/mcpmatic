import type { BlessRequest } from "../lib/register-all";

type Props = {
  request: BlessRequest | null;
  onDecide: (ok: boolean) => void;
};

export function BlessGate({ request, onDecide }: Props) {
  if (!request) return null;
  return (
    <div className="bless" role="dialog" aria-modal="true" aria-labelledby="bless-title">
      <div className="bless__card">
        <h2 id="bless-title">send these fields?</h2>
        <p>
          <code>{request.tool}</code> on {request.origin} wants:
        </p>
        <ul>
          {request.fieldNames.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p className="muted">
          Values go to {request.destination} through this worker. They are not
          stored here.
        </p>
        <div className="bless__actions">
          <button type="button" onClick={() => onDecide(false)}>
            Deny
          </button>
          <button type="button" className="primary" onClick={() => onDecide(true)}>
            Bless
          </button>
        </div>
      </div>
    </div>
  );
}
