/**
 * @vitest-environment node
 *
 * The composer must not be reachable only by scrolling.
 *
 * `.shell` was `min-height: 100dvh`, so the grid grew past the viewport
 * whenever the right column's content did — viewport, consent panel, actions.
 * The left column stretched with it and took `.chat__form` below the fold, so
 * typing a follow-up meant scrolling down to find the input, on every turn.
 *
 * `.chat__log` already declares `flex: 1; overflow: auto`, which is the right
 * shape: the log takes the slack and the form sits under it. That only works
 * if the column has a bounded height and its flex children may shrink, which
 * is what these assertions pin down. CSS is not unit-testable, so this guards
 * the structural invariant rather than the rendered result.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/index.css", "utf8");

/** The declarations inside one top-level rule, e.g. `.chat {…}`. */
function rule(selector: string): string {
  const match = css.match(
    new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `no rule found for ${selector}`).toBeTruthy();
  return (match as RegExpMatchArray)[2];
}

describe("the chat composer stays on screen", () => {
  it("bounds the shell to the viewport instead of growing past it", () => {
    const shell = rule(".shell");
    expect(shell).toMatch(/height:\s*100dvh/);
    // min-height alone is what let the grid grow and push the form down.
    expect(shell).not.toMatch(/min-height:\s*100dvh/);
  });

  it("lets the chat column shrink, so its log scrolls rather than the page", () => {
    // Without min-height:0 a flex child refuses to shrink below its content,
    // and the overflow moves to the page — taking the form with it.
    expect(rule(".chat")).toMatch(/min-height:\s*0/);
  });

  it("keeps the log as the part that scrolls", () => {
    const log = rule(".chat__log");
    expect(log).toMatch(/flex:\s*1/);
    expect(log).toMatch(/overflow:\s*auto/);
  });

  it("scrolls the right column on its own rather than the whole page", () => {
    const right = rule(".shell__right");
    expect(right).toMatch(/min-height:\s*0/);
    expect(right).toMatch(/overflow/);
  });
});
