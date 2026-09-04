/**
 * @vitest-environment node
 *
 * Every className a component uses must exist in the stylesheet.
 *
 * A mechanical rename (bless → approve) renamed the CSS selector to
 * `.approval` and the JSX literal to `approve`, leaving the approval dialog's
 * overlay with no class at all: no position:fixed, no centering, so it
 * rendered somewhere down the document flow and was invisible. Every one of
 * the 478 tests still passed, because nothing binds a class name to a
 * stylesheet.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(full) ? [full] : [];
  });
}

const css = readFileSync("src/index.css", "utf8");
const defined = new Set(
  [...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]),
);

describe("every className used has a rule", () => {
  it("finds no class the stylesheet never defines", () => {
    const missing: string[] = [];
    for (const file of sourceFiles("src")) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) {
          if (defined.has(cls)) continue;
          // A BEM modifier with no rule of its own is fine as long as its base
          // is styled: `chat__line--rich` marks a variant for behaviour and
          // inherits its looks from `chat__line`. A class whose base is also
          // undefined is what this test is for.
          const base = cls.split("--")[0];
          if (base !== cls && defined.has(base)) continue;
          missing.push(`${file}: ${cls}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
