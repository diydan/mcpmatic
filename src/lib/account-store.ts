const KEY = "mcpmatic.accountId";

type MinimalStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function isWellFormed(value: string | null): value is string {
  return typeof value === "string" && /^[A-Fa-f0-9]{64}$/.test(value);
}

/**
 * The console's durable identity.
 *
 * 256 bits of randomness kept in localStorage. It is a bearer credential of
 * the same class as the session token in the URL — whoever has it can inherit
 * the grants it carries — which is the deliberate trade for keeping "no login,
 * no key, no install" true while consent outlives a two-hour session.
 *
 * Returns null when storage is unavailable (private browsing, blocked site
 * data). No account is not an error: the session still works, its grants just
 * die with it, which is exactly the behaviour before accounts existed.
 */
export function ensureAccountId(storage: MinimalStorage): string | null {
  try {
    const existing = storage.getItem(KEY);
    if (isWellFormed(existing)) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    storage.setItem(KEY, id);
    return id;
  } catch {
    return null;
  }
}

export function accountId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return ensureAccountId(localStorage);
}
