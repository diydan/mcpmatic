import {
  SEED_PROFILE,
  resolveFields,
  type Profile,
} from "../../shared/profile";

// Same reason as account-store: renaming this key discards the profile.
const KEY = "mcpmatic.profile.v1";

function read(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SEED_PROFILE;
    const parsed = JSON.parse(raw) as Profile;
    return { ...SEED_PROFILE, ...parsed };
  } catch {
    return SEED_PROFILE;
  }
}

function write(profile: Profile): void {
  localStorage.setItem(KEY, JSON.stringify(profile));
}

export function seedIfEmpty(): void {
  if (!localStorage.getItem(KEY)) write(SEED_PROFILE);
}

/** The store exposes no whole-object getter. */
export const profileStore = {
  resolve(paths: readonly string[]): Record<string, string> {
    return resolveFields(read(), paths);
  },
  seed(): void {
    write(SEED_PROFILE);
  },
};
