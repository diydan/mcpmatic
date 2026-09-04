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
 * The default is **off**. After the 2026-09-04 security review split
 * `autoGrantNew` out of `autonomous`, both flags must fail closed by default:
 * a navigation an agent decides on for itself must not silently widen the
 * grant set. A user who wants the agent to roam the demo catalog has to
 * flip the consent switch.
 *
 * An explicit "1" turns it on; an explicit "0" keeps it off. An unrecognised
 * value or an absent row is treated as no choice at all and defaults to
 * **off** — the safe choice.
 */
export function autonomousFromStored(value: string | null | undefined): boolean {
  return value === "1";
}
