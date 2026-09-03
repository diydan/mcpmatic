import { isPrivateUrl } from "./is-private-url";
import { makeResolve4 } from "./doh-resolve4";
import { normaliseOrigin } from "../shared/origin";

/** Where an owner publishes the token that proves they control the origin. */
export const WELL_KNOWN_PATH = "/.well-known/mcpmatic.txt";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Site-owner telemetry.
 *
 * Reading is gated on proving control of the origin, because this is the
 * merchant's data and nobody else's. Publishing a file at a well-known path is
 * the cheapest proof that does not require an account, and the token they
 * published is then the credential for reading — whoever can put a file on the
 * site is exactly the audience.
 *
 * What comes back is per tool and never per caller. See site-summary.ts.
 */
export async function handleSite(
  request: Request,
  env: Env,
  sub: string,
): Promise<Response> {
  if (sub === "verify/start" && request.method === "POST") {
    const origin = await readOrigin(request);
    if (!origin) return json({ error: "invalid origin" }, 400);
    const { token } = await env.SITE.getByName(origin).issueToken();
    return json({
      origin,
      token,
      // Publishing invalidates nothing else: the token is scoped to one origin
      // and re-issuing clears any previous verification.
      publish: `${origin}${WELL_KNOWN_PATH}`,
      instructions: `Serve the token as the body of ${WELL_KNOWN_PATH}, then call verify/finish.`,
    });
  }

  if (sub === "verify/finish" && request.method === "POST") {
    const origin = await readOrigin(request);
    if (!origin) return json({ error: "invalid origin" }, 400);
    const site = env.SITE.getByName(origin);
    const expected = await site.expectedToken();
    if (!expected) return json({ error: "no verification started" }, 400);

    const url = `${origin}${WELL_KNOWN_PATH}`;
    // Same fail-closed guard as every other navigation this worker makes.
    if (await isPrivateUrl(url, makeResolve4())) {
      return json({ error: "refused (ssrf)" }, 400);
    }
    let published: string;
    try {
      const res = await fetch(url, { redirect: "error" });
      if (!res.ok) return json({ error: `could not read ${WELL_KNOWN_PATH}` }, 400);
      // Bounded: a token is 64 characters and a misconfigured host may serve a
      // whole page here.
      published = (await res.text()).slice(0, 4096).trim();
    } catch {
      return json({ error: `could not read ${WELL_KNOWN_PATH}` }, 400);
    }
    if (published !== expected) return json({ error: "token does not match" }, 400);
    await site.markVerified();
    return json({ ok: true, origin });
  }

  if (sub === "telemetry" && request.method === "GET") {
    const url = new URL(request.url);
    const origin = normaliseOrigin(url.searchParams.get("origin") ?? "");
    const token = bearer(request);
    if (!origin || !token) return json({ error: "origin and token required" }, 400);
    const site = env.SITE.getByName(origin);
    // One answer for "not verified", "wrong token" and "no such origin": a
    // read must not become an oracle for which origins we hold data on.
    if (!(await site.authorises(token))) return json({ error: "not authorised" }, 401);
    return json({ origin, tools: await site.summary() });
  }

  return json({ error: "not found" }, 404);
}

async function readOrigin(request: Request): Promise<string | null> {
  let body: { origin?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return null;
  }
  if (typeof body.origin !== "string") return null;
  return normaliseOrigin(body.origin);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer ([A-Fa-f0-9]{64})$/);
  return match ? match[1] : null;
}
