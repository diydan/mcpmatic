/**
 * When does an agent turn end?
 *
 * The composer is disabled while a turn is running, so getting this wrong in
 * one direction locks the user out and in the other lets a second turn race
 * the first. It used to be two scattered `setBusy(false)` calls — on `error`
 * and on the bridge closing — with nothing for the case where the turn simply
 * succeeded. The input locked the moment the agent answered and stayed locked,
 * on a page that looked perfectly healthy.
 *
 * Stated once, here, so a terminal state added later has an obvious home.
 */

/** The messages that mean the agent has stopped working and the composer is free. */
const TERMINAL = new Set(["assistant", "error"]);

export function endsTurn(type: string): boolean {
  return TERMINAL.has(type);
}
