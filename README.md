# Crypto AI Research

A small Vite + React + TypeScript app with a Node/Fastify backend that lets a local Ollama model call allowlisted crypto research tools.

## What It Does

- Runs a clean chat UI in the browser.
- Sends chat requests to a local Node API.
- Uses Ollama locally, defaulting to `qwen3:4b`.
- Lets the model call only safe, allowlisted tools:
  - Search CoinGecko coins.
  - Fetch CoinGecko prices and market data.
  - Fetch CoinGecko trending coins.
  - Fetch Binance public pair price.
- Keeps external API calls and tool execution on the backend.

This is for research and education only, not financial advice or trading automation.

## Prerequisites

- Node.js 22+
- Bun
- Ollama running locally
- The model pulled locally:

```sh
ollama pull qwen3:4b
```

## Setup

```sh
bun install
cp .env.example .env
bun run dev
```

Open the Vite URL shown in your terminal, usually:

```txt
http://localhost:5173
```

## Useful Prompts

- What is the current price of bitcoin and ethereum?
- Find coins related to solana and show the top matches.
- What crypto coins are trending right now?
- Compare BTC, ETH, and DOGE in USD.
- What is the Binance BTCUSDT price?

## Security Shape

The browser never talks directly to Ollama, CoinGecko, or Binance. The backend validates chat payloads, exposes only a single chat endpoint, validates model tool arguments with Zod, uses request timeouts, limits tool-loop iterations, and only runs known local functions. No arbitrary URL fetching or trading endpoints are exposed.
