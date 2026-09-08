/**
 * @vitest-environment node
 *
 * The composer is disabled while `busy` is true, and `busy` was cleared in
 * only two places: an `error` message, and the bridge closing. A turn that
 * *succeeded* cleared nothing, so the input locked the moment the agent
 * answered and stayed locked for the rest of the session — one message per
 * session, with the page looking perfectly healthy.
 *
 * It sat there harmlessly while turns never completed: the tool_call hole
 * meant they hung, and the bridge eventually closed, which did clear it.
 * Making the agent work is what exposed it.
 *
 * Extracted so the rule is stated once and tested, rather than living as two
 * `setBusy(false)` calls that a third terminal state would quietly miss.
 */
import { describe, expect, it } from "vitest";
import { endsTurn } from "../src/lib/turn-state";

describe("endsTurn", () => {
  it("ends on the assistant's reply — the normal way a turn finishes", () => {
    expect(endsTurn("assistant")).toBe(true);
  });

  it("ends on an error", () => {
    expect(endsTurn("error")).toBe(true);
  });

  it("does not end on a tool call — the turn is still running", () => {
    // The agent chains several of these before it answers. Releasing the
    // composer here would let a second turn race the first.
    expect(endsTurn("tool_call")).toBe(false);
  });

  it("does not end on a tool result", () => {
    expect(endsTurn("tool_exec_result")).toBe(false);
  });

  it("does not end on traffic that is not part of the turn", () => {
    for (const type of [
      "frame",
      "state",
      "audit",
      "origin_granted",
      "manifest_draft",
      "approval_request",
      "pong",
    ]) {
      expect(endsTurn(type), `${type} must not release the composer`).toBe(
        false,
      );
    }
  });

  it("does not end on an unknown message", () => {
    // A message this client does not know about says nothing about the turn.
    expect(endsTurn("something_added_later")).toBe(false);
  });
});
