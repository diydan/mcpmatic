export type Profile = {
  shopper: {
    firstName: string;
    lastName: string;
    size: string;
  };
  address: {
    line1: string;
    city: string;
    postcode: string;
    country: string;
  };
  traveler: {
    firstName: string;
    lastName: string;
    preferredCabin: string;
  };
};

export const SEED_PROFILE: Profile = {
  shopper: {
    firstName: "Dana",
    lastName: "Chi",
    size: "9",
  },
  address: {
    line1: "14 Rivington Street",
    city: "London",
    postcode: "EC2A 3DZ",
    country: "United Kingdom",
  },
  traveler: {
    firstName: "Dana",
    lastName: "Chi",
    preferredCabin: "economy",
  },
};

const LEAF: Record<string, (p: Profile) => string> = {
  "shopper.firstName": (p) => p.shopper.firstName,
  "shopper.lastName": (p) => p.shopper.lastName,
  "shopper.size": (p) => p.shopper.size,
  "address.line1": (p) => p.address.line1,
  "address.city": (p) => p.address.city,
  "address.postcode": (p) => p.address.postcode,
  "address.country": (p) => p.address.country,
  "traveler.firstName": (p) => p.traveler.firstName,
  "traveler.lastName": (p) => p.traveler.lastName,
  "traveler.preferredCabin": (p) => p.traveler.preferredCabin,
};

export const PROFILE_PATHS = Object.freeze(Object.keys(LEAF));

/** Resolver keyed by declared field paths. There is no whole-object getter. */
export function resolveFields(
  profile: Profile,
  paths: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    const read = LEAF[path];
    if (!read) continue;
    out[path] = read(profile);
  }
  return out;
}

export function hasWholeObjectGetter(store: object): boolean {
  return "getProfile" in store || "toJSON" in store || "dump" in store;
}
