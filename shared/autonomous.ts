import { unionOrigins } from "./origin";

/** Union current grants with the catalog so autonomous mode opens every demo origin. */
export function mergeAutonomousConsent(
  current: readonly string[],
  catalog: readonly string[],
): string[] {
  return unionOrigins(current, catalog);
}

/**
 * Whether a session acts without a grant click per origin.
 *
 * Automation is the default: an absent row means on. The product is for people
 * who want an agent to get on with it, and asking permission per origin before
 * anything has happened is friction without a decision behind it.
 *
 * The 2026-09-04 security review set this to fail closed. That was reverted as
 * a product decision: the boundary that matters is a profile *value* leaving
 * the device, and that gate is untouched — a tool drawing on the profile still
 * cannot run unattended. Granting an origin only decides which tools are
 * listed. The review's structural change is kept: `autoGrantNew` remains a
 * separate switch, so catalog automation can stay on while off-catalog
 * auto-granting is turned off. Both simply default on rather than off.
 *
 * An explicit "0" outranks the default and survives reloads, because a human
 * who turned it off has made a choice and a default must not undo it. An
 * unrecognised value is treated as no choice at all.
 */
export function autonomousFromStored(value: string | null | undefined): boolean {
  return value === "0" ? false : true;
}
