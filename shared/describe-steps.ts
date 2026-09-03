import type { ManifestStep } from "./manifest";

/**
 * One plain-language line per step, for the manifest review screen — the
 * human reads exactly what a generated tool will do before blessing it.
 *
 * Transparency substitutes for automated judgment here (SPEC, Review &
 * bless): this renders every step faithfully and never tries to score or
 * flag which of them look destructive.
 */
export function describeStep(step: ManifestStep): string {
  switch (step.action) {
    case "goto":
      return `opens ${step.url}`;
    case "fill":
      return `fills ${step.selector} from ${step.from}`;
    case "type":
      return `types into ${step.selector} from ${step.from}`;
    case "click":
      return `clicks ${step.selector}`;
    case "press":
      return `presses ${step.key} on ${step.selector}`;
    case "wait":
      return `waits for ${step.selector}`;
  }
}
