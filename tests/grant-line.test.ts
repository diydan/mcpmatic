/**
 * @vitest-environment node
 *
 * One human grant, one transcript line.
 *
 * `persistConsent` appended `granted <origin>` locally AND the DO's
 * `origin_granted` broadcast (source "user") appended the identical string
 * through the new handler, so every human grant printed twice — on the
 * address-bar submit, the Consent panel's Grant button, and the "or any site"
 * form alike.
 */
import { describe, expect, it } from "vitest";
import { grantTranscriptLine, type GrantEvent } from "../src/lib/grant-line";

const ORIGIN = "https://www.allbirds.com";

/** Every event this page sees when the human grants an origin here. */
const HUMAN_GRANT: GrantEvent[] = [
  { kind: "local-grant", origin: ORIGIN },
  { kind: "broadcast", origin: ORIGIN, source: "user" },
];

/** Every event this page sees when the agent picks an origin on its own. */
const MODEL_GRANT: GrantEvent[] = [
  { kind: "broadcast", origin: ORIGIN, source: "model" },
];

const linesFor = (events: GrantEvent[]) =>
  events.map(grantTranscriptLine).filter((l): l is string => l !== null);

describe("grantTranscriptLine", () => {
  it("writes exactly one line for a human grant", () => {
    expect(linesFor(HUMAN_GRANT)).toEqual([`granted ${ORIGIN}`]);
  });

  it("writes exactly one line for a model-picked origin", () => {
    expect(linesFor(MODEL_GRANT)).toEqual([
      "Opening allbirds.com — granted for this session",
    ]);
  });

  it("makes the broadcast the author, not the local POST", () => {
    // The broadcast is the half that fires for both sources and reaches a
    // second console tab, so it is the one that keeps the line.
    expect(grantTranscriptLine({ kind: "local-grant", origin: ORIGIN })).toBeNull();
    expect(
      grantTranscriptLine({ kind: "broadcast", origin: ORIGIN, source: "user" }),
    ).not.toBeNull();
  });

  it("words a model pick differently from a human grant", () => {
    // Spec §3: the transcript has to distinguish an origin the agent chose
    // from one the user typed.
    const [human] = linesFor(HUMAN_GRANT);
    const [model] = linesFor(MODEL_GRANT);
    expect(human).not.toBe(model);
    expect(model).toMatch(/granted for this session/);
    expect(human).not.toMatch(/granted for this session/);
  });

  it("shows the bare host for a model pick and the full origin for a grant", () => {
    // The human typed the origin, so echoing it back is a confirmation of
    // what they entered; the model's pick is news, and reads as a host.
    expect(linesFor(MODEL_GRANT)[0]).not.toContain("https://");
    expect(linesFor(HUMAN_GRANT)[0]).toContain("https://");
  });

  it("falls back to the origin when it is not a parseable URL", () => {
    expect(
      grantTranscriptLine({ kind: "broadcast", origin: "not a url", source: "model" }),
    ).toBe("Opening not a url — granted for this session");
  });
});
