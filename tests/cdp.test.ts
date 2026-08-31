import { describe, expect, it, vi } from "vitest";
import { dispatchKey, keyParams, startScreencast } from "../worker/cdp";

describe("keyParams", () => {
  it("gives Enter a virtual key code and text so a form submits", () => {
    const down = keyParams("keyDown", "Enter");
    expect(down).toMatchObject({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
    });
  });

  it("does not repeat the text on keyUp", () => {
    expect(keyParams("keyUp", "Enter")).not.toHaveProperty("text");
  });

  it("codes the other keys a login form needs", () => {
    expect(keyParams("keyDown", "Tab")).toMatchObject({ windowsVirtualKeyCode: 9 });
    expect(keyParams("keyDown", "Backspace")).toMatchObject({
      windowsVirtualKeyCode: 8,
    });
    expect(keyParams("keyDown", "ArrowDown")).toMatchObject({
      windowsVirtualKeyCode: 40,
    });
  });
});

describe("dispatchKey", () => {
  it("sends a char event with text for a printable key", async () => {
    const send = vi.fn(async () => undefined);
    await dispatchKey({ send, on: vi.fn() }, { type: "char", text: "a" });
    expect(send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "char",
      text: "a",
      unmodifiedText: "a",
      key: "a",
    });
  });
});

describe("startScreencast", () => {
  it("enables the Page domain before starting, and acks every frame", async () => {
    const send = vi.fn(async () => undefined);
    let emit: ((f: { data: string; sessionId: number }) => void) | null = null;
    const on = vi.fn((_event: string, handler: (f: never) => void) => {
      emit = handler as unknown as typeof emit;
    });
    const frames: string[] = [];

    await startScreencast({ send, on }, (f) => frames.push(f.data));

    const methods = send.mock.calls.map((c) => c[0]);
    expect(methods.indexOf("Page.enable")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("Page.enable")).toBeLessThan(
      methods.indexOf("Page.startScreencast"),
    );

    emit!({ data: "jpeg", sessionId: 7 });
    expect(frames).toEqual(["jpeg"]);
    expect(send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 7 });
  });

  it("survives an ack that rejects after the page navigated away", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "Page.screencastFrameAck") throw new Error("no session");
      return undefined;
    });
    let emit: ((f: { data: string; sessionId: number }) => void) | null = null;
    const on = vi.fn((_e: string, h: (f: never) => void) => {
      emit = h as unknown as typeof emit;
    });
    const frames: string[] = [];
    await startScreencast({ send, on }, (f) => frames.push(f.data));

    emit!({ data: "jpeg", sessionId: 1 });
    // An unhandled rejection here would take down the Durable Object.
    await new Promise((r) => setTimeout(r, 0));
    expect(frames).toEqual(["jpeg"]);
  });
});
