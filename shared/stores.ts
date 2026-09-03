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
  {
    origin: "https://www.gov.uk",
    slug: "gov_uk",
    label: "GOV.UK",
    kind: "facade",
    blurb:
      "Find your local council. Bless a postcode; the rest of the profile stays on this device.",
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
      // Mirrors Shopify's own search_catalog schema so arguments pass through
      // untranslated. Verified against allbirds.com 2026-09-01.
      inputSchema: {
        type: "object",
        properties: {
          catalog: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query string." },
              pagination: {
                type: "object",
                properties: {
                  limit: {
                    type: "integer",
                    description: "Max results per type (1-10). Defaults to 5.",
                    minimum: 1,
                    maximum: 10,
                  },
                },
              },
            },
            required: ["query"],
          },
        },
        required: ["catalog"],
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
      // Mirrors Shopify's own update_cart schema. Verified 2026-09-01.
      inputSchema: {
        type: "object",
        properties: {
          cart: {
            type: "object",
            properties: {
              line_items: {
                type: "array",
                description: "Items to add or update (1-10).",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description:
                        "Existing cart line id from get_cart. Use to update or remove an existing line. Omit when adding new items.",
                    },
                    handle: {
                      type: "string",
                      description:
                        "Product handle. Adds the selected or first available variant.",
                    },
                    query: {
                      type: "string",
                      description:
                        "Search query to find and add the selected or first available variant.",
                    },
                    quantity: {
                      type: "integer",
                      description: "Quantity for this line. 0 removes it.",
                      minimum: 0,
                    },
                  },
                },
              },
            },
            required: ["line_items"],
          },
        },
        required: ["cart"],
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

const govUk: ToolManifest = {
  name: "find_local_council_on_gov_uk",
  kind: "facade",
  origin: "https://www.gov.uk",
  description:
    "Find the local council for the shopper's postcode on GOV.UK. Blesses only address.postcode; does not send name or the rest of the profile. Does not log the value.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  fillsFrom: ["address.postcode"],
  steps: [
    { action: "goto", url: "https://www.gov.uk/find-local-council" },
    {
      action: "click",
      selector: "button[data-accept-cookies='false']",
    },
    {
      action: "fill",
      selector: "input[name='postcode'], #postcode",
      from: "address.postcode",
    },
    {
      action: "click",
      selector: "main button[type='submit'], main .govuk-button",
    },
  ],
};

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
    govUk,
  ];
}
