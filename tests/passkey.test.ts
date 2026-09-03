import { describe, expect, it } from "vitest";
import { fromStoredCredential, rpIdFor, toStoredCredential } from "../worker/passkey";

describe("rpIdFor", () => {
  it("is the hostname, without scheme or port", () => {
    expect(rpIdFor("https://mcpmatic.dan-3c7.workers.dev/account/passkey")).toBe(
      "mcpmatic.dan-3c7.workers.dev",
    );
  });

  it("keeps localhost usable in development", () => {
    // WebAuthn allows localhost over http; a dev server must be able to
    // register a passkey or nobody can test this path.
    expect(rpIdFor("http://localhost:5173/x")).toBe("localhost");
  });

  it("returns null for something that is not a url", () => {
    expect(rpIdFor("not a url")).toBeNull();
  });
});

describe("credential storage round-trip", () => {
  const credential = {
    id: "Y3JlZC1pZA",
    publicKey: new Uint8Array([1, 2, 250, 0, 255]),
    counter: 7,
    transports: ["internal", "hybrid"],
  };

  it("survives being stored and read back", () => {
    // The public key is bytes and the row is text. Getting this wrong breaks
    // every future login with a signature error and no other clue.
    const back = fromStoredCredential(toStoredCredential(credential));
    expect(back).toEqual(credential);
  });

  it("stores the public key as text, not as an object", () => {
    const stored = toStoredCredential(credential);
    expect(typeof stored.publicKey).toBe("string");
    expect(JSON.parse(JSON.stringify(stored)).publicKey).toBe(stored.publicKey);
  });

  it("round-trips a credential with no transports", () => {
    const bare = { id: "a", publicKey: new Uint8Array([9]), counter: 0 };
    expect(fromStoredCredential(toStoredCredential(bare))).toEqual({
      ...bare,
      transports: undefined,
    });
  });

  it("preserves a counter of zero rather than dropping it", () => {
    const stored = toStoredCredential({
      id: "a",
      publicKey: new Uint8Array([1]),
      counter: 0,
    });
    expect(fromStoredCredential(stored).counter).toBe(0);
  });
});
