import type { ClientMessage } from "../../shared/protocol";
import type { BlessRequest } from "./register-all";

type ApprovalRequest = {
  id: string;
  origin: string;
  tool: string;
  fieldNames: string[];
};

type Deps = {
  bless: (req: BlessRequest) => Promise<boolean>;
  resolveFields: (paths: readonly string[]) => Record<string, string>;
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
  let ok = false;
  try {
    ok = await deps.bless({
      origin: req.origin,
      tool: req.tool,
      fieldNames: req.fieldNames,
      destination: req.origin,
    });
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
