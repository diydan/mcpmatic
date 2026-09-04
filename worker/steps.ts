import type { ManifestStep } from "../shared/manifest";

/**
 * How long a selector gets before we call the element absent.
 *
 * Playwright's default is 30 seconds, which is a sensible budget for a page
 * that is still loading and a terrible one for a page that simply does not
 * have the field. `fill_checkout` declares six fills; at the default they
 * serialise to three minutes, past the bridge's own 120s timeout, so the human
 * saw nothing at all. The same 8s budget the native-tool poll uses
 * (`native-webmcp.ts`) is generous for an element on a page already open.
 */
export const ELEMENT_TIMEOUT_MS = 8000;

/** Just enough of a Playwright page to act on elements that are already there. */
export type ElementPage = {
  fill?: (
    selector: string,
    value: string,
    opts?: { timeout?: number },
  ) => Promise<void>;
  click?: (selector: string, opts?: { timeout?: number }) => Promise<void>;
  press?: (
    selector: string,
    key: string,
    opts?: { timeout?: number },
  ) => Promise<void>;
  waitForSelector?: (
    selector: string,
    opts?: { timeout?: number },
  ) => Promise<unknown>;
};

/**
 * `absent` is a finding, not an error. A cookie banner that is not there is
 * ordinary; six checkout fields that are not there means the tool did nothing,
 * and only the caller counting them can tell those two apart.
 */
export type StepOutcome = "landed" | "absent";

/**
 * The shortest look worth taking once the page has already been given its
 * full budget. The DOM has settled by then; a field that is not there now is
 * not going to arrive.
 */
export const SETTLED_TIMEOUT_MS = 500;

/** Acts on one element step. `goto` is not here: it needs the SSRF guard. */
export async function runElementStep(
  page: ElementPage,
  step: Exclude<ManifestStep, { action: "goto" }>,
  args: Record<string, unknown>,
  timeout: number = ELEMENT_TIMEOUT_MS,
): Promise<StepOutcome> {
  try {
    if (step.action === "fill" || step.action === "type") {
      if (!page.fill) return "absent";
      await page.fill(step.selector, String(args[step.from] ?? ""), { timeout });
      return "landed";
    }
    if (step.action === "click") {
      if (!page.click) return "absent";
      await page.click(step.selector, { timeout });
      return "landed";
    }
    if (step.action === "press") {
      if (!page.press) return "absent";
      await page.press(step.selector, step.key, { timeout });
      return "landed";
    }
    if (!page.waitForSelector) return "absent";
    await page.waitForSelector(step.selector, { timeout });
    return "landed";
  } catch {
    return "absent";
  }
}

export type StepReport = { fillsAttempted: number; fillsLanded: number };

/**
 * Runs a manifest's steps against the page that is open.
 *
 * The budget belongs to the page, not to each field. The first element step
 * may wait the full `ELEMENT_TIMEOUT_MS` for the page to settle; after that
 * the DOM is as loaded as it is going to get, so every later step gets a
 * glance. Six missing checkout fields cost eight seconds between them instead
 * of eight seconds each — the difference between a tool that says "there is no
 * form here" and one that outlives the bridge waiting to say it.
 *
 * A `goto` starts a new page, and a new budget with it. Navigation is the
 * caller's to perform: it is the step that leaves the origin, so it is the
 * step that needs the SSRF guard.
 */
export async function runSteps(
  page: ElementPage,
  steps: readonly ManifestStep[],
  args: Record<string, unknown>,
  goto: (url: string) => Promise<void>,
  now: () => number = Date.now,
): Promise<StepReport> {
  let deadline = now() + ELEMENT_TIMEOUT_MS;
  let fillsAttempted = 0;
  let fillsLanded = 0;

  for (const step of steps) {
    if (step.action === "goto") {
      await goto(interpolate(step.url, args));
      deadline = now() + ELEMENT_TIMEOUT_MS;
      continue;
    }
    const timeout = Math.max(SETTLED_TIMEOUT_MS, deadline - now());
    const outcome = await runElementStep(page, step, args, timeout);
    if (step.action === "fill" || step.action === "type") {
      fillsAttempted += 1;
      if (outcome === "landed") fillsLanded += 1;
    }
  }
  return { fillsAttempted, fillsLanded };
}

/** Values are URL-encoded: a step's argument must not reshape the path. */
function interpolate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) =>
    encodeURIComponent(String(args[key] ?? "")),
  );
}
