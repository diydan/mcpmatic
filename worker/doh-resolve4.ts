/**
 * DoH (DNS-over-HTTPS) resolver wrapper.
 *
 * Replaces the `[[unsafe.bindings]] type = "resolve4"` runtime binding
 * (which required an account-level Cloudflare dashboard opt-in — see
 * [[project_browser_mcp_10021_unsafe_bindings_toggle]]) with a vanilla
 * `fetch` to Cloudflare's public DoH endpoint. The function shape is
 * identical to the binding's `env.RESOLVE4.resolve4(hostname)` so the
 * call site in `src/index.ts` swaps with a one-line change.
 *
 * Endpoint: https://cloudflare-dns.com/dns-query
 *   GET ?name=<hostname>&type=A    (DNS type 1)
 *   GET ?name=<hostname>&type=AAAA (DNS type 28) — parallel (#2784)
 *   Accept: application/dns-json
 *   → 200 application/dns-json body with { Status, Answer: [{ type, data }] }
 *
 * Why Cloudflare's own DoH?  1.1.1.1 is a CF service; the endpoint
 * serves out of the CF edge; no new third-party dependency.  Cost is
 * +20–50 ms per resolution (1 round trip to the edge; A+AAAA run in
 * parallel so wall time stays ~one RTT).  TOCTOU window is unchanged
 * from the unsafe binding — both approaches only narrow the DNS-rebind
 * gap between the guard-time lookup and the browser's fetch-time lookup;
 * neither fully closes it.  See is-private-url.ts "Known limitation".
 *
 * Fail-closed contract (matches the unsafe binding's contract):
 *   - non-2xx HTTP response     → throws (isPrivateUrl catches + rejects)
 *   - network error             → throws (isPrivateUrl catches + rejects)
 *   - malformed JSON            → throws (isPrivateUrl catches + rejects)
 *   - missing/empty Answer      → returns [] when BOTH queries empty
 *                                 (isPrivateUrl rejects)
 *
 * #2784: A-only resolution missed the dual-stack rebind case (public A +
 * private AAAA). We now collect A (type 1) and AAAA (type 28) addresses;
 * isPrivateUrl's PRIVATE_IP_PATTERNS already includes IPv6 patterns.
 *
 * The function is intentionally decoupled from the worker's `Env`
 * (it takes a `fetchFn` directly) so it can be unit-tested without a
 * Workers runtime and reused by any future caller.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/**
 * Per-resolution timeout. The CF navigate tool has an 8s `PAGE_TIMEOUT_MS`
 * and the worker has a 10s wall-time budget; a hung DoH resolver would
 * otherwise eat the navigation budget. 2s is well above the typical
 * 1.1.1.1 round-trip (20–50 ms) and well below the navigate timeout.
 * `AbortSignal.timeout(ms)` is supported in workerd (Workers runtime).
 * Applied independently to each of the A and AAAA fetches.
 */
const DOH_TIMEOUT_MS = 2_000;

/** DNS type numbers we collect as address records. */
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

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

export type Resolve4 = (hostname: string) => Promise<string[]>;

async function queryDoH(
  fetchFn: typeof fetch,
  endpoint: string,
  hostname: string,
  recordType: "A" | "AAAA",
): Promise<string[]> {
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
  // record type are filtered out — isPrivateUrl is regex-based and would
  // not match a non-IP string, which would let the URL through.
  // `.trim()` defends against a (theoretical) malformed data field with
  // leading/trailing whitespace that would slip the prefix-anchored
  // PRIVATE_IP_PATTERNS regex check.
  return body.Answer
    .filter(
      (a): a is DoHAnswer & { data: string } =>
        a.type === wantType && typeof a.data === "string",
    )
    .map((a) => a.data.trim());
}

/**
 * Build a `resolve4(hostname)` function backed by Cloudflare DoH.
 *
 * Despite the name (historical, from the IPv4-only Workers binding),
 * this now returns **both** A and AAAA addresses so dual-stack rebind
 * attacks are visible to `isPrivateUrl` (#2784).
 *
 * @param fetchFn - injectable `fetch` (default: global `fetch`). Tests
 *   pass a `vi.fn()`; production uses the Workers global.
 * @param endpoint - injectable DoH endpoint URL (default: Cloudflare).
 *   Reserved for future override (e.g. an internal DoH proxy); not
 *   wired through wrangler config yet.
 */
export function makeResolve4(
  fetchFn: typeof fetch = fetch,
  endpoint: string = DOH_ENDPOINT,
): Resolve4 {
  return async (hostname: string): Promise<string[]> => {
    // Parallel A + AAAA: wall time stays ~one RTT; either failure fails
    // the whole resolution (fail-closed — isPrivateUrl rejects).
    const [v4, v6] = await Promise.all([
      queryDoH(fetchFn, endpoint, hostname, "A"),
      queryDoH(fetchFn, endpoint, hostname, "AAAA"),
    ]);
    return [...v4, ...v6];
  };
}
