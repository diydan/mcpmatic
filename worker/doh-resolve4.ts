/**
 * DNS-over-HTTPS resolver, used by `is-private-url.ts`.
 *
 * Endpoint: https://cloudflare-dns.com/dns-query
 *   GET ?name=<hostname>&type=A     (DNS type 1)
 *   GET ?name=<hostname>&type=AAAA  (DNS type 28) — issued in parallel
 *   Accept: application/dns-json
 *   → 200 application/dns-json with { Status, Answer: [{ type, data }] }
 *
 * Why Cloudflare's own DoH: it is served from the same edge this worker runs
 * on, so no new third-party dependency. Cost is roughly one extra round trip
 * (A and AAAA run in parallel, so wall time stays ~1 RTT).
 *
 * Fail-closed contract:
 *   - non-2xx response  → throws (isPrivateUrl catches and rejects)
 *   - network error     → throws
 *   - malformed JSON    → throws
 *   - empty Answer      → returns [] when BOTH queries are empty, which
 *                         isPrivateUrl also treats as a rejection
 *
 * Both A and AAAA are collected. Resolving only A missed the dual-stack
 * rebind case — a public A record beside a private AAAA — and
 * `parseIp` (see `shared/net.ts`) covers the IPv6 forms.
 *
 * It takes a `fetchFn` rather than the worker `Env` so it can be unit-tested
 * without a Workers runtime.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/**
 * Per-resolution timeout. A hung resolver would otherwise eat the navigation
 * budget. 2s is well above a typical round trip (20–50 ms) and well below the
 * 30s navigation timeout. Applied independently to the A and AAAA fetches.
 */
const DOH_TIMEOUT_MS = 2_000;

/** DNS type numbers we collect as address records. */
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

/**
 * Floor below which a short-TTL attack is feasible. A resolver that flips a
 * record inside 30 s is exactly the rebind window we fear; refusing anything
 * lower forces the attacker to commit to the address they give us for the
 * full navigation window. (Review H2.)
 */
export const MIN_TTL_SECONDS = 30;

/** One address record as returned by `makeResolve4Records`. */
export type ResolvedRecord = { ip: string; ttl: number };

/** Resolve a hostname to all of its (TTL-filtered) A and AAAA records. */
export type Resolve4Records = (hostname: string) => Promise<ResolvedRecord[]>;

/** Legacy: just the IPs, dropping TTLs. */
export type Resolve4 = (hostname: string) => Promise<string[]>;

/** Shape of one entry in a Cloudflare DoH JSON `Answer` array. */
interface DoHAnswer {
  name?: string;
  type?: number;
  TTL?: number;
  /** For A records (type 1): IPv4 string. For AAAA (28): IPv6. For CNAME (5): hostname. */
  data?: string;
}

/** Shape of the Cloudflare DoH JSON response we care about. */
interface DoHResponse {
  Status?: number;
  Answer?: DoHAnswer[];
  [key: string]: unknown;
}

async function queryDoH(
  fetchFn: typeof fetch,
  endpoint: string,
  hostname: string,
  recordType: "A" | "AAAA",
): Promise<ResolvedRecord[]> {
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${recordType}`;

  const res = await fetchFn(url, {
    headers: { Accept: "application/dns-json" },
    // Abort after DOH_TIMEOUT_MS so a hung resolver fails closed
    // quickly instead of eating the navigation budget. The thrown
    // AbortError is caught by isPrivateUrl's try/catch and converted
    // to a reject.
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });

  if (!res.ok) {
    // isPrivateUrl's try/catch catches this and rejects the URL.
    throw new Error(
      `DoH ${endpoint} returned HTTP ${res.status} for "${hostname}" (type=${recordType})`,
    );
  }

  let body: DoHResponse;
  try {
    body = (await res.json()) as DoHResponse;
  } catch (err) {
    throw new Error(
      `DoH ${endpoint} returned non-JSON body for "${hostname}" (type=${recordType}): ${(err as Error).message}`,
    );
  }

  if (!body.Answer || !Array.isArray(body.Answer) || body.Answer.length === 0) {
    return [];
  }

  const wantType = recordType === "A" ? DNS_TYPE_A : DNS_TYPE_AAAA;

  // Only address records of the requested type. CNAME (5) and any other
  // record type are filtered out — isPrivateUrl uses parseIp and rejects
  // anything that isn't a parseable IPv4/IPv6 literal.
  // `.trim()` defends against a (theoretical) malformed data field with
  // leading/trailing whitespace that would slip the parse.
  //
  // TTL floor: a sub-MIN_TTL_SECONDS answer is exactly the rebind window.
  // Refusing it forces the attacker to commit to the address for the full
  // navigation window. Records without a TTL are likewise dropped — an
  // attacker would love us to ignore the timing channel.
  return body.Answer
    .filter(
      (a): a is DoHAnswer & { data: string } =>
        a.type === wantType && typeof a.data === "string",
    )
    .filter((a) => (a.TTL ?? 0) >= MIN_TTL_SECONDS)
    .map((a) => ({ ip: a.data.trim(), ttl: a.TTL ?? 0 }));
}

/**
 * Build a `resolve4Records(hostname)` function backed by Cloudflare DoH.
 *
 * Despite the name, this returns **both** A and AAAA records, so dual-stack
 * rebind attacks are visible to `isPrivateUrl`.
 *
 * @param fetchFn - injectable `fetch` (default: the global). Tests pass a
 *   `vi.fn()`; production uses the Workers global.
 * @param endpoint - injectable DoH endpoint (default: Cloudflare). Reserved
 *   for an override such as an internal resolver; not wired to config yet.
 */
export function makeResolve4Records(
  fetchFn: typeof fetch = fetch,
  endpoint: string = DOH_ENDPOINT,
): Resolve4Records {
  return async (hostname: string): Promise<ResolvedRecord[]> => {
    // Parallel A + AAAA: wall time stays ~one RTT; either failure fails
    // the whole resolution (fail-closed — isPrivateUrl rejects).
    const [v4, v6] = await Promise.all([
      queryDoH(fetchFn, endpoint, hostname, "A"),
      queryDoH(fetchFn, endpoint, hostname, "AAAA"),
    ]);
    return [...v4, ...v6];
  };
}

/**
 * Build a `resolve4(hostname)` that returns only the IP strings, dropping
 * TTL. Kept for callers that don't need the timing channel.
 */
export function makeResolve4(
  fetchFn: typeof fetch = fetch,
  endpoint: string = DOH_ENDPOINT,
): Resolve4 {
  const records = makeResolve4Records(fetchFn, endpoint);
  return async (hostname: string): Promise<string[]> =>
    (await records(hostname)).map((r) => r.ip);
}