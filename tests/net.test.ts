import { describe, expect, it } from "vitest";
import { parseIp } from "../shared/net";

describe("parseIp", () => {
  it.each([
    ["127.0.0.1"],
    ["10.0.0.5"],
    ["172.16.0.1"],
    ["172.31.255.254"],
    ["192.168.1.1"],
    ["169.254.169.254"],
    ["0.0.0.0"],
    ["100.64.0.1"],       // CGNAT
    ["255.255.255.255"],  // broadcast
  ])("marks %s as v4 private/loopback", (raw) => {
    const r = parseIp(raw);
    expect(r).not.toBeNull();
    expect(r!.family).toBe(4);
    expect(r!.isPrivate || r!.isLoopback || r!.isLinkLocal).toBe(true);
  });

  it("recognises ::1 in compressed form", () => {
    const r = parseIp("::1");
    expect(r).not.toBeNull();
    expect(r!.family).toBe(6);
    expect(r!.isLoopback).toBe(true);
  });

  it("recognises fe80::1 as link-local", () => {
    const r = parseIp("fe80::1");
    expect(r?.family).toBe(6);
    expect(r?.isLinkLocal).toBe(true);
  });

  it("recognises fe90::1 as link-local (within fe80::/10)", () => {
    // fe80::/10 is the IETF link-local block, not fe80::/16. fe90
    // shares the top 10 bits with fe80 and must be classified
    // link-local — otherwise an SSRF target could bypass the
    // isPrivateUrl check by using any non-fe80:: link-local address.
    expect(parseIp("fe90::1")?.isLinkLocal).toBe(true);
  });

  it("recognises febf::1 as link-local (upper edge of fe80::/10)", () => {
    // febf is the last /16 inside fe80::/10 — the top 10 bits are
    // still 1111_1110_10. Must be classified link-local.
    expect(parseIp("febf::1")?.isLinkLocal).toBe(true);
  });

  it("does not classify fec0::1 as link-local (just past fe80::/10)", () => {
    // fec0 sits just outside fe80::/10 — the top 10 bits are
    // 1111_1110_11, not 1111_1110_10. Must NOT be classified
    // link-local; the /10 edge is the binding boundary.
    expect(parseIp("fec0::1")?.isLinkLocal).toBe(false);
  });

  it("recognises fc00::/7 unique-local", () => {
    expect(parseIp("fc00::1")?.isPrivate).toBe(true);
    expect(parseIp("fd12:3456:789a::1")?.isPrivate).toBe(true);
  });

  it("recognises IPv4-mapped ::ffff:7f00:1 as loopback", () => {
    const r = parseIp("::ffff:7f00:1");
    expect(r).not.toBeNull();
    expect(r!.isLoopback || r!.isPrivate).toBe(true);
  });

  it("rejects non-IP strings", () => {
    expect(parseIp("example.com")).toBeNull();
    expect(parseIp("::zzz")).toBeNull();
    expect(parseIp("1.2.3")).toBeNull();
  });

  it("accepts a public IPv6", () => {
    expect(parseIp("2606:4700:4700::1111")?.isPrivate).toBe(false);
    expect(parseIp("2606:4700:4700::1111")?.isLoopback).toBe(false);
  });

  it("accepts a public IPv4", () => {
    expect(parseIp("1.1.1.1")?.family).toBe(4);
    expect(parseIp("1.1.1.1")?.isPrivate).toBe(false);
    expect(parseIp("1.1.1.1")?.isLoopback).toBe(false);
  });
});
