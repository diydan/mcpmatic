import type { ToolManifest } from "./manifest";

export type StoreKind = "shopify-webmcp" | "facade";

export type Store = {
  origin: string;
  slug: string;
  label: string;
  kind: StoreKind;
  blurb: string;
};

/** Demo stores. Shopify Liquid already ships native WebMCP; we proxy those tools. */
export const STORES: Store[] = [
  {
    origin: "https://www.allbirds.com",
    slug: "allbirds_com",
    label: "Allbirds",
    kind: "shopify-webmcp",
    blurb: "Liquid storefront. Native search_catalog / update_cart / proceed_to_checkout.",
  },
  {
    origin: "https://www.brooklinen.com",
    slug: "brooklinen_com",
    label: "Brooklinen",
    kind: "shopify-webmcp",
    blurb: "Liquid storefront. Same Shopify WebMCP pack, different merchant.",
  },
  {
    origin: "https://www.kayak.com",
    slug: "kayak_com",
    label: "Kayak",
    kind: "facade",
    blurb: "No WebMCP. The façade synthesises a search tool and drives the page.",
  },
];

function shopifyTools(store: Store): ToolManifest[] {
  const suffix = `_on_${store.slug}`;
  const origin = store.origin;
  return [
    {
      name: `search_catalog${suffix}`,
      nativeName: "search_catalog",
      kind: "shopify-webmcp",
      origin,
      description: `Search ${store.label}'s catalog via the store's own Shopify WebMCP search_catalog tool (not a click replay). Query products, collections, articles.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      steps: [
        { action: "goto", url: `${origin}/search?q={{query}}` },
      ],
    },
    {
      name: `update_cart${suffix}`,
      nativeName: "update_cart",
      kind: "shopify-webmcp",
      origin,
      description: `Add or change cart lines on ${store.label} via native Shopify WebMCP update_cart. Same storefront actions the theme uses.`,
      inputSchema: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "What to add, remove, or change, including variant if known",
          },
        },
        required: ["instruction"],
        additionalProperties: false,
      },
      steps: [],
    },
    {
      name: `proceed_to_checkout${suffix}`,
      nativeName: "proceed_to_checkout",
      kind: "shopify-webmcp",
      origin,
      description: `Open ${store.label} checkout with the current cart via native proceed_to_checkout. Does not complete payment.`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      steps: [],
    },
    {
      name: `fill_checkout${suffix}`,
      kind: "shopify-webmcp",
      origin,
      description: `Fill ${store.label} checkout with the shopper's local profile fields only (name + address). Shopify WebMCP has no shipping-profile tool; this is the gap. Does not submit payment.`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      fillsFrom: [
        "shopper.firstName",
        "shopper.lastName",
        "address.line1",
        "address.city",
        "address.postcode",
        "address.country",
      ],
      steps: [
        { action: "fill", selector: "input[autocomplete='given-name']", from: "shopper.firstName" },
        { action: "fill", selector: "input[autocomplete='family-name']", from: "shopper.lastName" },
        { action: "fill", selector: "input[autocomplete='address-line1']", from: "address.line1" },
        { action: "fill", selector: "input[autocomplete='address-level2']", from: "address.city" },
        { action: "fill", selector: "input[autocomplete='postal-code']", from: "address.postcode" },
        { action: "fill", selector: "input[autocomplete='country']", from: "address.country" },
      ],
    },
  ];
}

const kayak: ToolManifest = {
  name: "search_flights_on_kayak_com",
  kind: "facade",
  origin: "https://www.kayak.com",
  description:
    "Search flights on kayak.com. Kayak does not ship WebMCP, so this tool is synthesised and executed over CDP.",
  inputSchema: {
    type: "object",
    properties: {
      origin: { type: "string", description: "Departure IATA code" },
      destination: { type: "string", description: "Arrival IATA code" },
      date: { type: "string", description: "Outbound date YYYY-MM-DD" },
    },
    required: ["origin", "destination", "date"],
    additionalProperties: false,
  },
  steps: [
    {
      action: "goto",
      url: "https://www.kayak.com/flights/{{origin}}-{{destination}}/{{date}}",
    },
  ],
};

export function allManifests(): ToolManifest[] {
  return [
    ...STORES.filter((s) => s.kind === "shopify-webmcp").flatMap(shopifyTools),
    kayak,
  ];
}
