import type { ApprovalRequest } from "../lib/register-all";

type Props = {
  request: ApprovalRequest | null;
  onDecide: (ok: boolean) => void;
};

export function ApprovalDialog({ request, onDecide }: Props) {
  if (!request) return null;
  return (
    <div className="approval" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="approval__card">
        <h2 id="approval-title">Approve details to fill?</h2>
        <p>
          The website at <strong>{request.origin.replace(/^https:\/\//, "")}</strong> is requesting to fill the following details:
        </p>
        <ul>
          {request.fieldNames.map((name) => (
            <li key={name}>
              <span>{name.replace(/[._]/g, " ")}</span>
            </li>
          ))}
        </ul>
        <p className="muted">
          Your personal details are filled directly onto the website and are never saved on external servers.
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
