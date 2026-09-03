/**
 * Short-lived, single-use WebAuthn challenges.
 *
 * A challenge has to survive between "give me options" and "here is the
 * signed response", and a login challenge is issued *before* anyone knows
 * which account will answer it — the account arrives in the assertion's
 * `userHandle`. So it cannot live in the account's own Durable Object; it
 * needs a store the worker can reach without knowing whose it is.
 *
 * This reuses the KV bound as `OAUTH_TOKENS`. The binding is named for its
 * first tenant, but what it is, is a store of short-lived opaque values with a
 * TTL, which is exactly this. Keys are prefixed so the two never collide.
 */

export type ChallengeRecord =
  | { kind: "login" }
  | { kind: "register"; accountId: string };

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

function key(challenge: string): string {
  return `webauthn:${challenge}`;
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
