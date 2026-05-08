import { z } from "zod";
import { config } from "./config.js";
import { fetchJson } from "./http.js";

type JsonSchema = {
  type: "object";
  required?: string[];
  additionalProperties?: boolean;
  properties: Record<string, unknown>;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

type ToolHandler = {
  definition: ToolDefinition;
  schema: z.ZodTypeAny;
  run: (input: any) => Promise<unknown>;
};

type CoinGeckoSearchResponse = {
  coins: Array<{
    id: string;
    name: string;
    symbol: string;
    api_symbol?: string;
    market_cap_rank: number | null;
    thumb?: string;
    large?: string;
  }>;
};

type CoinGeckoTrendingResponse = {
  coins: Array<{
    item: {
      id: string;
      name: string;
      symbol: string;
      market_cap_rank: number | null;
      thumb?: string;
      small?: string;
      large?: string;
      data?: {
        price?: string;
        price_change_percentage_24h?: Record<string, number>;
        market_cap?: string;
        total_volume?: string;
      };
    };
  }>;
};

type CoinGeckoPriceResponse = Record<
  string,
  {
    [key: string]: number | null | undefined;
    usd?: number;
    usd_market_cap?: number;
    usd_24h_vol?: number;
    usd_24h_change?: number;
    last_updated_at?: number;
  }
>;

type BinanceTickerPriceResponse = {
  symbol: string;
  price: string;
};

const coinIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);

const vsCurrencySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(12)
  .regex(/^[a-z0-9]+$/);

const coingeckoHeaders = (): HeadersInit => {
  if (!config.COINGECKO_API_KEY) {
    return {};
  }

  return {
    [config.COINGECKO_API_KEY_TYPE === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]:
      config.COINGECKO_API_KEY
  };
};

const coingeckoUrl = (path: string) => new URL(`${config.COINGECKO_API_BASE}${path}`);

const tools = {
  search_crypto_coins: {
    definition: {
      type: "function",
      function: {
        name: "search_crypto_coins",
        description:
          "Search CoinGecko for crypto coins by name, symbol, or keyword. Use this before price lookup when the user gives a fuzzy name.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "Coin name, symbol, or keyword, for example bitcoin, btc, solana, meme."
            },
            limit: {
              type: "integer",
              description: "Maximum number of matching coins to return. Default 8, max 15."
            }
          }
        }
      }
    },
    schema: z.object({
      query: z.string().trim().min(1).max(80),
      limit: z.number().int().min(1).max(15).optional().default(8)
    }),
    run: async ({ query, limit }) => {
      const url = coingeckoUrl("/search");
      url.searchParams.set("query", query);

      const data = await fetchJson<CoinGeckoSearchResponse>(url, {
        headers: coingeckoHeaders()
      });

      return {
        coins: data.coins.slice(0, limit).map((coin) => ({
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          marketCapRank: coin.market_cap_rank,
          image: coin.thumb ?? coin.large ?? null
        }))
      };
    }
  },
  get_crypto_price: {
    definition: {
      type: "function",
      function: {
        name: "get_crypto_price",
        description:
          "Get current prices and market fields for one or more CoinGecko coin IDs. Use CoinGecko IDs like bitcoin, ethereum, solana.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["coinIds"],
          properties: {
            coinIds: {
              type: "array",
              description: "CoinGecko coin IDs.",
              items: { type: "string" },
              minItems: 1,
              maxItems: 10
            },
            vsCurrency: {
              type: "string",
              description: "Target fiat or crypto currency, default usd."
            }
          }
        }
      }
    },
    schema: z.object({
      coinIds: z.array(coinIdSchema).min(1).max(10),
      vsCurrency: vsCurrencySchema.optional().default("usd")
    }),
    run: async ({ coinIds, vsCurrency }) => {
      const url = coingeckoUrl("/simple/price");
      url.searchParams.set("ids", coinIds.join(","));
      url.searchParams.set("vs_currencies", vsCurrency);
      url.searchParams.set("include_market_cap", "true");
      url.searchParams.set("include_24hr_vol", "true");
      url.searchParams.set("include_24hr_change", "true");
      url.searchParams.set("include_last_updated_at", "true");

      const data = await fetchJson<CoinGeckoPriceResponse>(url, {
        headers: coingeckoHeaders()
      });

      return {
        vsCurrency,
        prices: Object.entries(data).map(([id, fields]) => ({
          id,
          price: fields[vsCurrency],
          marketCap: fields[`${vsCurrency}_market_cap`],
          volume24h: fields[`${vsCurrency}_24h_vol`],
          change24h: fields[`${vsCurrency}_24h_change`],
          lastUpdatedAt: fields.last_updated_at
        }))
      };
    }
  },
  get_trending_crypto: {
    definition: {
      type: "function",
      function: {
        name: "get_trending_crypto",
        description: "Get CoinGecko trending search coins from the last 24 hours.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              description: "Maximum number of trending coins to return. Default 10, max 15."
            }
          }
        }
      }
    },
    schema: z.object({
      limit: z.number().int().min(1).max(15).optional().default(10)
    }),
    run: async ({ limit }) => {
      const url = coingeckoUrl("/search/trending");
      const data = await fetchJson<CoinGeckoTrendingResponse>(url, {
        headers: coingeckoHeaders()
      });

      return {
        coins: data.coins.slice(0, limit).map(({ item }) => ({
          id: item.id,
          name: item.name,
          symbol: item.symbol,
          marketCapRank: item.market_cap_rank,
          price: item.data?.price ?? null,
          marketCap: item.data?.market_cap ?? null,
          volume: item.data?.total_volume ?? null,
          change24hUsd: item.data?.price_change_percentage_24h?.usd ?? null,
          image: item.thumb ?? item.small ?? item.large ?? null
        }))
      };
    }
  },
  get_binance_pair_price: {
    definition: {
      type: "function",
      function: {
        name: "get_binance_pair_price",
        description:
          "Get the latest public Binance spot ticker price for an exact trading pair like BTCUSDT or ETHUSDT.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["symbol"],
          properties: {
            symbol: {
              type: "string",
              description: "Binance spot symbol in uppercase or lowercase, for example BTCUSDT."
            }
          }
        }
      }
    },
    schema: z.object({
      symbol: z
        .string()
        .trim()
        .toUpperCase()
        .min(5)
        .max(20)
        .regex(/^[A-Z0-9]+$/)
    }),
    run: async ({ symbol }) => {
      const url = new URL(`${config.BINANCE_API_BASE}/api/v3/ticker/price`);
      url.searchParams.set("symbol", symbol);

      const data = await fetchJson<BinanceTickerPriceResponse>(url);

      return {
        symbol: data.symbol,
        price: Number(data.price),
        rawPrice: data.price
      };
    }
  }
} satisfies Record<string, ToolHandler>;

export const toolDefinitions = Object.values(tools).map((tool) => tool.definition);

export type ToolTrace = {
  name: string;
  arguments: unknown;
  result: unknown;
};

export async function runTool(name: string, input: unknown): Promise<unknown> {
  const tool = tools[name as keyof typeof tools] as ToolHandler | undefined;

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const parsed = tool.schema.parse(input);
  return await tool.run(parsed);
}
