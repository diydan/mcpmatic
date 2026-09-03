import type { ApprovalRequest } from "../lib/register-all";

type Props = {
  request: ApprovalRequest | null;
  onDecide: (ok: boolean) => void;
};

export function ApprovalDialog({ request, onDecide }: Props) {
  if (!request) return null;
  return (
    <div className="approve" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="approval__card">
        <h2 id="approval-title">send these fields?</h2>
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
        <div className="approval__actions">
          <button type="button" onClick={() => onDecide(false)}>
            Deny
          </button>
          <button type="button" className="primary" onClick={() => onDecide(true)}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
