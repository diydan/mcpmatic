import type { ToolManifest } from "../../shared/manifest";
import { describeStep } from "../../shared/describe-steps";

export type ManifestDraft = {
  origin: string;
  tools: ToolManifest[];
};

type Props = {
  draft: ManifestDraft | null;
  onDecide: (name: string, approve: boolean) => void;
};

/**
 * Confirms a *tool* should exist at all, once, before it is ever callable —
 * distinct from ApprovalDialog, which confirms a *value* leaving the device on
 * a specific call. Approval is per-tool, never all-or-nothing for the origin.
 */
export function ManifestReview({ draft, onDecide }: Props) {
  if (!draft || draft.tools.length === 0) return null;
  const host = draft.origin.replace(/^https:\/\//, "");
  return (
    <div
      className="manifest-review"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manifest-review-title"
    >
      <div className="manifest-review__card">
        <h2 id="manifest-review-title">new tools found on {host}</h2>
        <p className="muted">
          Generated from the page, not the site&apos;s own code. Review each one before it
          becomes callable.
        </p>
        <ul className="manifest-review__tools">
          {draft.tools.map((tool) => (
            <li key={tool.name}>
              <h3>
                <code>{tool.name}</code>
              </h3>
              <p>{tool.description}</p>
              <ol className="manifest-review__steps">
                {tool.steps.map((step, i) => (
                  <li key={i}>{describeStep(step)}</li>
                ))}
              </ol>
              <div className="manifest-review__actions">
                <button type="button" onClick={() => onDecide(tool.name, false)}>
                  Decline
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => onDecide(tool.name, true)}
                >
                  Approve
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
