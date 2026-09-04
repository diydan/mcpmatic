import type { ClientMessage } from "../../shared/protocol";
import type { BlessRequest } from "./register-all";

type ApprovalRequest = {
  id: string;
  origin: string;
  tool: string;
  fieldNames: string[];
  /** When the server stops waiting. Absent on older servers. */
  expiresAt?: number;
};

type Deps = {
  bless: (req: BlessRequest) => Promise<boolean>;
  resolveFields: (paths: readonly string[]) => Record<string, string>;
  /** Close a dialog the server has stopped waiting on. */
  dismiss?: () => void;
};

/**
 * Answer a suspended tool call.
 *
 * The console is the only place the profile exists, so this is where a value
 * enters the system — and it enters exactly once, for exactly the paths the
 * request named. There is no branch here that sends more than was asked for.
 *
 * A throw becomes a denial rather than silence: an MCP client is waiting on
 * the other end, and the gate's 45-second timeout is a backstop, not a plan.
 */
export async function answerApproval(
  req: ApprovalRequest,
  deps: Deps,
): Promise<Extract<ClientMessage, { type: "approval_result" }>> {
  const deny = {
    v: 1,
    type: "approval_result",
    id: req.id,
    ok: false,
  } as const;
  // A request the server has already given up on must not raise a dialog: a
  // click on it can do nothing, and a control that does nothing is worse than
  // no control at all.
  const remaining = req.expiresAt ? req.expiresAt - Date.now() : null;
  if (remaining !== null && remaining <= 0) return deny;

  let ok = false;
  try {
    ok = remaining === null
      ? await deps.bless(blessRequest(req))
      : await raceDeadline(deps.bless(blessRequest(req)), remaining, deps.dismiss);
  } catch {
    return deny;
  }
  if (!ok) return deny;
  return {
    v: 1,
    type: "approval_result",
    id: req.id,
    ok: true,
    fills: deps.resolveFields(req.fieldNames),
  };
}

function blessRequest(req: ApprovalRequest): BlessRequest {
  return {
    origin: req.origin,
    tool: req.tool,
    fieldNames: req.fieldNames,
    destination: req.origin,
  };
}

/**
 * Whichever comes first: the human, or the server's deadline.
 *
 * On expiry the dialog is closed rather than left standing. It was showing a
 * question nobody is waiting for the answer to.
 */
function raceDeadline(
  decision: Promise<boolean>,
  ms: number,
  dismiss?: () => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      dismiss?.();
      resolve(false);
    }, ms);
    void decision.then(
      (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
