/**
 * Search listings tool (mocked backend).
 *
 * Schema follows OpenAI function calling format. v0.2 will proxy to the
 * úlovdomov.cz internal search API or a read-only public export.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

export const searchListingsTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_listings",
    description:
      "Search úlovdomov.cz listings by user-provided criteria. Returns the top " +
      "matching listings ordered by score (relevance + freshness). Use this when " +
      "the user asks to find a property or filter by criteria.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["transaction_type"],
      properties: {
        transaction_type: {
          type: "string",
          enum: ["rent", "buy"],
          description:
            "rent = monthly rental. buy = purchase. Infer from price: prices below " +
            "100,000 CZK without explicit Kč/měsíc default to rent.",
        },
        city: {
          type: "string",
          description: "City name (Brno, Praha, Ostrava, …). Optional.",
        },
        district: {
          type: "string",
          description:
            "City district / quarter (Vinohrady, Karlín, …). Optional. Only meaningful " +
            "when `city` is set.",
        },
        disposition: {
          type: "string",
          enum: [
            "garsoniéra",
            "1+kk",
            "1+1",
            "2+kk",
            "2+1",
            "3+kk",
            "3+1",
            "4+kk",
            "4+1",
            "5+kk",
            "5+1",
            "dům",
            "atypický",
          ],
          description: "Czech-standard property disposition code.",
        },
        min_price_czk: { type: "integer", minimum: 0 },
        max_price_czk: { type: "integer", minimum: 0 },
        min_area_m2: { type: "integer", minimum: 0 },
        max_area_m2: { type: "integer", minimum: 0 },
        allows_pets: {
          type: "boolean",
          description: "Filter by pet-friendly listings.",
        },
        furnished: {
          type: "boolean",
          description: "Filter by furnished status.",
        },
        balcony: { type: "boolean" },
        parking: { type: "boolean" },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Cap on the number of results to return. Defaults to 10.",
        },
      },
    },
  },
};

export interface SearchListingsArgs {
  transaction_type: "rent" | "buy";
  city?: string;
  district?: string;
  disposition?: string;
  min_price_czk?: number;
  max_price_czk?: number;
  min_area_m2?: number;
  max_area_m2?: number;
  allows_pets?: boolean;
  furnished?: boolean;
  balcony?: boolean;
  parking?: boolean;
  max_results?: number;
}

export interface Listing {
  id: string;
  title: string;
  address: string;
  district: string;
  city: string;
  price_czk: number;
  area_m2: number;
  disposition: string;
  highlights: string[];
  url: string;
}

export interface SearchListingsResult {
  total_count: number;
  shown_count: number;
  listings: Listing[];
}

/** Mock implementation. Returns a deterministic synthetic result set. */
export async function searchListings(args: SearchListingsArgs): Promise<SearchListingsResult> {
  // v0.2 will call the real backend. For v0.1 the agent prompt covers
  // the shape of the response and the chatbot CLI surfaces the mock data.
  const mock: Listing[] = [
    {
      id: "487001",
      title: "Slunný 2+kk se sklepem",
      address: "Königova 5",
      district: "Veveří",
      city: args.city ?? "Brno",
      price_czk: 11_500,
      area_m2: 48,
      disposition: args.disposition ?? "2+kk",
      highlights: ["1.5 km od náměstí Svobody", "kočky/psi do 15 kg OK"],
      url: "https://www.ulovdomov.cz/inzerat/487001",
    },
    {
      id: "487012",
      title: "Po rekonstrukci, klidná čtvrť",
      address: "Lerchova 12",
      district: "Stránice",
      city: args.city ?? "Brno",
      price_czk: 12_800,
      area_m2: 52,
      disposition: args.disposition ?? "2+kk",
      highlights: ["mladí majitelé", "prohlídka možná víkend"],
      url: "https://www.ulovdomov.cz/inzerat/487012",
    },
    {
      id: "487034",
      title: "Útulný 2+kk u parku",
      address: "Tučkova 17",
      district: "Žabovřesky",
      city: args.city ?? "Brno",
      price_czk: 10_900,
      area_m2: 45,
      disposition: args.disposition ?? "2+kk",
      highlights: ["pár metrů od Riegrových sadů", "bez balkonu"],
      url: "https://www.ulovdomov.cz/inzerat/487034",
    },
  ];

  const max = args.max_results ?? 10;
  return {
    total_count: 12,
    shown_count: Math.min(mock.length, max),
    listings: mock.slice(0, max),
  };
}
