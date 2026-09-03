import { unionOrigins } from "./origin";

/** Union current grants with the catalog so autonomous mode opens every demo origin. */
export function mergeAutonomousConsent(
  current: readonly string[],
  catalog: readonly string[],
): string[] {
  return unionOrigins(current, catalog);
}
