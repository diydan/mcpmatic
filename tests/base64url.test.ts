import { describe, expect, it } from "vitest";
import { base64urlNoPad, base64urlToBytes } from "../worker/oauth/encoding";

describe("base64urlToBytes", () => {
  it("round-trips every byte value", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(base64urlToBytes(base64urlNoPad(all))).toEqual(all);
  });

  it("decodes input whose length needs one padding character", () => {
    // 2 bytes -> 3 base64 chars. A decoder that forgets to restore "=" throws.
    const bytes = new Uint8Array([1, 2]);
    expect(base64urlToBytes(base64urlNoPad(bytes))).toEqual(bytes);
  });

  it("decodes input whose length needs two padding characters", () => {
    const bytes = new Uint8Array([1]);
    expect(base64urlToBytes(base64urlNoPad(bytes))).toEqual(bytes);
  });

  it("accepts the url-safe alphabet", () => {
    // 0xfb 0xff encodes to "-_8" in base64url and "+/8" in plain base64.
    const bytes = new Uint8Array([251, 255, 60]);
    const encoded = base64urlNoPad(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(base64urlToBytes(encoded)).toEqual(bytes);
  });

  it("returns an empty array for an empty string", () => {
    expect(base64urlToBytes("")).toEqual(new Uint8Array(0));
  });
});
