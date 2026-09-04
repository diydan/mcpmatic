// shared/net.ts
//
// Single source of truth for "is this address private?". The previous
// implementation tested hostname *strings* against a small regex set
// (`PRIVATE_IP_PATTERNS`) and missed the canonical compressed forms and
// the IPv4-mapped IPv6 space — see 2026-09-04 review, H1.
//
// This module parses both IPv4 dotted-decimal and IPv6 (any of: full,
// zero-compressed, bracketed, `::ffff:a.b.c.d` mapped, `%zone-id`)
// strings into a normalised form, then runs a numeric range test
// against the IETF ranges we care about. Both v4 and v6 share the same
// shape so the worker and tests can treat them uniformly.

const UNSPECIFIED_V4 = 0x00000000;
const BROADCAST_V4 = 0xffffffff;
const LOOPBACK_V4: readonly [number, number] = [0x7f000000, 0x7fffffff];
const LINK_LOCAL_V4: readonly [number, number] = [0xa9fe0000, 0xa9feffff];
const PRIVATE_V4: readonly (readonly [number, number])[] = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
];
const DOCS_V4: readonly [number, number] = [0x01020300, 0x010203ff]; // 1.2.3.0/24

function parseV4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function inRange(n: number, range: readonly [number, number]): boolean {
  return n >= range[0] && n <= range[1];
}

const IPV6_LOOPBACK = 1n;
const IPV6_UNSPECIFIED = 0n;
// Top-64-bit prefix/mask for IPv6 link-local (fe80::/10).
// Applied as ((n >> 64n) & MASK) === PREFIX — see parseIp. The mask
// occupies the top 10 bits of the 64-bit value (0xffc0_0000_0000_0000n
// = 1111_1111_1100_0000...), leaving the bottom 54 bits zero so they
// don't constrain. /10 covers the entire IETF link-local block
// (fe80::..febf:...), not just the literal fe80::/16.
const IPV6_LL_PREFIX = 0xfe80_0000_0000_0000n;
const IPV6_LL_MASK  = 0xffc0_0000_0000_0000n;
// Top-64-bit prefix/mask for IPv6 unique-local (fc00::/7).
// /7 covers both fc00::/8 and fd00::/8 (first 7 bits = 1111110).
// The brief's draft used 0xffff_..._0000n which only matched /8 and
// missed `fd...` addresses — see task-4 deviation ledger.
const IPV6_ULA_PREFIX = 0xfc00_0000_0000_0000n;
const IPV6_ULA_MASK = 0xfe00_0000_0000_0000n;
// IPv4-mapped IPv6 (::ffff:a.b.c.d) has the top 96 bits equal to
// 0x0000_0000_0000_0000_0000_ffff. After shifting right by 32, those 96
// bits become a 96-bit number whose value is just 0xffff (the high
// 80 bits are zero). The brief's draft used `0xffff_0000_0000n` here,
// which is the wrong constant — that value would only match if the
// `ffff` lived at bits 33-48 of the full 128-bit address, but in
// `::ffff:a.b.c.d` it lives at bits 17-32. See task-4 deviation ledger.
const IPV6_V4_MAPPED_PREFIX = 0xffffn;

function parseV6(s: string): bigint | null {
  // Strip a trailing %zone-id (e.g. fe80::1%eth0). Strip surrounding [].
  let raw = s;
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  const z = raw.indexOf("%");
  if (z !== -1) raw = raw.slice(0, z);
  if (!raw.includes(":")) return null;
  if (raw === "::") return 0n;

  // Split on "::" — at most one occurrence in a valid address.
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fillCount = 8 - (left.length + right.length);
  if (fillCount < 0) return null;
  const groups: string[] = [
    ...left,
    ...Array(fillCount).fill("0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

export type ParsedIp = {
  family: 4 | 6;
  /** RFC 1918 / RFC 4193 / RFC 6890 ranges we treat as off-limits. */
  isPrivate: boolean;
  isLoopback: boolean;
  isLinkLocal: boolean;
  isDocumentation: boolean;
};

export function parseIp(raw: string): ParsedIp | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Detected v4 by the presence of dots and no colons.
  if (raw.includes(".") && !raw.includes(":")) {
    const n = parseV4(raw);
    if (n === null) return null;
    return {
      family: 4,
      isLoopback: inRange(n, LOOPBACK_V4),
      isLinkLocal: inRange(n, LINK_LOCAL_V4),
      isPrivate:
        n === UNSPECIFIED_V4 ||
        n === BROADCAST_V4 ||
        PRIVATE_V4.some((r) => inRange(n, r)),
      isDocumentation: inRange(n, DOCS_V4),
    };
  }
  // v6 (any spelling): try the colon branch.
  let n = parseV6(raw);
  if (n === null) return null;
  // IPv4-mapped: ::ffff:a.b.c.d. The top 96 bits are
  // 0x0000_0000_0000_0000_0000_ffff (a 96-bit value equal to 0xffff).
  // We unwrap to the embedded IPv4 and recurse so the caller gets a
  // single, uniform shape.
  if ((n >> 32n) === IPV6_V4_MAPPED_PREFIX) {
    const v4 = Number(n & 0xffffffffn) >>> 0;
    return parseIp(`${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`);
  }
  return {
    family: 6,
    isLoopback: n === IPV6_LOOPBACK || n === IPV6_UNSPECIFIED,
    isLinkLocal: ((n >> 64n) & IPV6_LL_MASK) === IPV6_LL_PREFIX,
    isPrivate: ((n >> 64n) & IPV6_ULA_MASK) === IPV6_ULA_PREFIX,
    isDocumentation: false,
  };
}

/** Strip the brackets around an IPv6 literal in a URL hostname. */
export function extractHostname(url: URL): string {
  let h = url.hostname;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.toLowerCase();
}
