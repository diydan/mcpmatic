import { describe, expect, it } from "vitest";
import { parseBridgeRole } from "../worker/bridge-role";

describe("parseBridgeRole", () => {
  it("recognises a console socket", () => {
    expect(parseBridgeRole("https://x/s/abc/bridge?role=console")).toBe("console");
  });

  it("recognises a façade socket", () => {
    expect(parseBridgeRole("https://x/s/abc/bridge?role=facade")).toBe("facade");
  });

  it("treats an unlabelled socket as a façade, not a console", () => {
    // Fail closed. An approval must never be routed to a socket that did not
    // say it was a console — including every client written before this
    // parameter existed.
    expect(parseBridgeRole("https://x/s/abc/bridge")).toBe("facade");
  });

  it("treats an unrecognised role as a façade", () => {
    expect(parseBridgeRole("https://x/s/abc/bridge?role=admin")).toBe("facade");
  });

  it("does not accept a differently-cased console", () => {
    expect(parseBridgeRole("https://x/s/abc/bridge?role=Console")).toBe("facade");
  });

  it("treats an unparseable url as a façade", () => {
    expect(parseBridgeRole("not a url")).toBe("facade");
  });
});
