/** Union current grants with the catalog so autonomous mode opens every demo origin. */
export function mergeAutonomousConsent(
  current: readonly string[],
  catalog: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const origin of [...current, ...catalog]) {
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}
