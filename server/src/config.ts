import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen3:4b"),
  COINGECKO_API_BASE: z.string().url().default("https://api.coingecko.com/api/v3"),
  COINGECKO_API_KEY: z.string().optional().default(""),
  COINGECKO_API_KEY_TYPE: z.enum(["demo", "pro"]).default("demo"),
  BINANCE_API_BASE: z.string().url().default("https://api.binance.com")
});

export const config = envSchema.parse(process.env);
