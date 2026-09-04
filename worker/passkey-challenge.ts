/**
 * Short-lived, single-use WebAuthn challenges and step-up tokens.
 *
 * A challenge has to survive between "give me options" and "here is the
 * signed response", and a login challenge is issued *before* anyone knows
 * which account will answer it — the account arrives in the assertion's
 * `userHandle`. So it cannot live in the account's own Durable Object; it
 * needs a store the worker can reach without knowing whose it is.
 *
 * A step-up token survives the same ceremony and ties the assertion to a
 * specific {accountId, sessionToken} pair. It is the second credential the
 * /s/<token>/account claim needs: knowledge of the session URL is no longer
 * enough, the caller must also produce a fresh WebAuthn assertion against an
 * authenticator bound to the account they are claiming. Single-use, 5-minute
 * TTL, bound to both the session and the account — a replay against a
 * different session, or a different account, returns null rather than a match.
 *
 * This reuses the KV bound as `OAUTH_TOKENS`. The binding is named for its
 * first tenant, but what it is, is a store of short-lived opaque values with a
 * TTL, which is exactly this. Keys are prefixed so the two never collide:
 * `webauthn:<challenge>` for the ceremony challenge, `stepup:<token>` for the
 * step-up token returned to the client.
 */

export type ChallengeRecord =
  | { kind: "login" }
  | { kind: "register"; accountId: string }
  | { kind: "stepup"; accountId: string; sessionToken: string };

export type ChallengeKv = {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

/**
 * Five minutes. Long enough for a human to find a security key or approve a
 * biometric prompt, short enough that an abandoned ceremony is not a
 * credential waiting to be picked up.
 */
const CHALLENGE_TTL_SECONDS = 300;
/**
 * Same TTL for the step-up token. The ceremony and the token share an expiry
 * budget on purpose: if the user took longer than five minutes to answer the
 * assertion prompt, the token behind it should not survive either.
 */
const STEP_UP_TTL_SECONDS = 300;

function key(challenge: string): string {
  return `webauthn:${challenge}`;
}

function stepUpKey(token: string): string {
  return `stepup:${token}`;
}

export async function putChallenge(
  kv: ChallengeKv,
  challenge: string,
  record: ChallengeRecord,
): Promise<void> {
  await kv.put(key(challenge), JSON.stringify(record), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
}

/**
 * Read and consume. Single-use is the point: a challenge that survives its
 * first answer is a ceremony that can be replayed.
 */
export async function takeChallenge(
  kv: ChallengeKv,
  challenge: string,
): Promise<ChallengeRecord | null> {
  const raw = await kv.get(key(challenge));
  if (raw === null) return null;
  await kv.delete(key(challenge));
  try {
    return JSON.parse(raw) as ChallengeRecord;
  } catch {
    return null;
  }
}

/**
 * Mint a step-up token bound to `{ accountId, sessionToken }`. The KV value
 * carries a `kind: "stepup"` discriminator so a stray record under the
 * `stepup:*` namespace from any other source cannot be consumed as a token by
 * `takeStepUp` — only records minted by this function pass the kind gate.
 *
 * The token itself is whatever string the caller passes in: this module does
 * not generate it. In practice the worker generates 32 bytes of randomness
 * (see `worker/passkey-routes.ts` `step-up/verify`).
 */
export async function mintStepUp(
  kv: ChallengeKv,
  token: string,
  record: { accountId: string; sessionToken: string },
): Promise<void> {
  await kv.put(
    stepUpKey(token),
    JSON.stringify({
      kind: "stepup",
      accountId: record.accountId,
      sessionToken: record.sessionToken,
    }),
    { expirationTtl: STEP_UP_TTL_SECONDS },
  );
}

/**
 * Read-and-consume a step-up token only if every bound field does. A token
 * with a matching key but a mismatched `accountId` or `sessionToken` is not
 * a partial match — it is a forgery attempt, and `null` is the only safe
 * answer. The record is *not* deleted on a mismatch, so the rightful holder
 * can still claim it; an attacker probing with the wrong binding cannot lock
 * the real consumer out.
 */
export async function takeStepUp(
  kv: ChallengeKv,
  token: string,
  expected: { accountId: string; sessionToken: string },
): Promise<{ accountId: string; sessionToken: string } | null> {
  const raw = await kv.get(stepUpKey(token));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      kind?: unknown;
      accountId?: unknown;
      sessionToken?: unknown;
    };
    if (parsed.kind !== "stepup") return null;
    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.sessionToken !== "string"
    ) {
      return null;
    }
    if (
      parsed.accountId !== expected.accountId ||
      parsed.sessionToken !== expected.sessionToken
    ) {
      return null;
    }
    await kv.delete(stepUpKey(token));
    return {
      accountId: parsed.accountId,
      sessionToken: parsed.sessionToken,
    };
  } catch {
    return null;
  }
}