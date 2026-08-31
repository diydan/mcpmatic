import { describe, expect, it, vi } from "vitest";
import { isPrivateUrl } from "../worker/is-private-url";

describe("isPrivateUrl", () => {
  it("refuses a private IP literal", async () => {
    expect(await isPrivateUrl("http://127.0.0.1/", vi.fn())).toBe(true);
    expect(await isPrivateUrl("http://192.168.1.8/", vi.fn())).toBe(true);
  });

  it("refuses non-http schemes", async () => {
    expect(await isPrivateUrl("file:///etc/passwd", vi.fn())).toBe(true);
  });

  it("fails closed when the resolver throws", async () => {
    expect(
      await isPrivateUrl("https://example.com", async () => {
        throw new Error("dns down");
      }),
    ).toBe(true);
  });

  it("fails closed on empty resolution", async () => {
    expect(await isPrivateUrl("https://example.com", async () => [])).toBe(true);
  });

  it("refuses a public name that rebinds to a private A record", async () => {
    expect(
      await isPrivateUrl("https://evil.example", async () => ["127.0.0.1"]),
    ).toBe(true);
  });

  it("allows a public A and AAAA", async () => {
    expect(
      await isPrivateUrl("https://example.com", async () => [
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]),
    ).toBe(false);
  });
});
