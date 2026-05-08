import { z } from "zod";
import { config } from "./config.js";
import { toolDefinitions, runTool, type ToolTrace } from "./cryptoTools.js";

const chatRoleSchema = z.enum(["user", "assistant"]);

export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.string().trim().min(1).max(8_000)
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(24),
  model: z.string().trim().min(1).max(80).optional()
});

type PublicChatMessage = z.infer<typeof chatMessageSchema>;

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
};

type OllamaToolCall = {
  function: {
    name: string;
    arguments: unknown;
  };
};

type OllamaStreamChunk = {
  message?: {
    role?: "assistant";
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
};

export type AgentEvent =
  | { type: "delta"; content: string }
  | { type: "tool"; trace: ToolTrace }
  | { type: "done"; content: string; model: string; toolTrace: ToolTrace[] }
  | { type: "error"; message: string; kind?: "ollama_unreachable" | "ollama_model_missing" | "timeout" | "unknown" };

const systemPrompt = [
  "You are a crypto research assistant running locally through Ollama.",
  "Tools available: search_crypto_coins (fuzzy name → coin id), get_crypto_price (CoinGecko prices by id), get_trending_crypto, get_binance_pair_price.",
  "Prefer ONE tool call per question. Only chain tools when the user asks for a comparison, or when you must search for a coin id before a price lookup.",
  "Once a tool returns the data needed, answer directly. Do NOT call another tool to confirm a value you already have.",
  "Never invent live prices. Cite the source (CoinGecko or Binance) and include the timestamp when present.",
  "Keep answers to 1–3 short sentences. No <think> tags, no chain-of-thought, just the final answer.",
  "Research only, not financial advice."
].join(" ");

const MAX_TOOL_ROUNDS = 4;
const OLLAMA_IDLE_TIMEOUT_MS = 120_000;
const OLLAMA_NUM_PREDICT = 768;

function stripThinking(content: string) {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function toOllamaMessages(messages: PublicChatMessage[]): OllamaMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: message.content
    }))
  ];
}

function ollamaChatUrl() {
  return new URL(`${config.OLLAMA_BASE_URL}/api/chat`);
}

async function* streamOllamaChat(
  model: string,
  messages: OllamaMessage[]
): AsyncGenerator<OllamaStreamChunk, void, void> {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), OLLAMA_IDLE_TIMEOUT_MS);
  };
  resetIdle();

  let response: Response;
  try {
    response = await fetch(ollamaChatUrl(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson"
      },
      body: JSON.stringify({
        model,
        messages,
        tools: toolDefinitions,
        stream: true,
        think: false,
        keep_alive: "5m",
        options: {
          temperature: 0.2,
          num_predict: OLLAMA_NUM_PREDICT
        }
      })
    });
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    throw error;
  }

  if (!response.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    const body = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${body.slice(0, 400)}`);
  }
  if (!response.body) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error("Ollama returned an empty response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            yield JSON.parse(line) as OllamaStreamChunk;
          } catch {
            // skip malformed line
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as OllamaStreamChunk;
      } catch {
        // ignore
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function classifyError(message: string): NonNullable<Extract<AgentEvent, { type: "error" }>["kind"]> {
  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    return "ollama_unreachable";
  }
  if (message.includes("model '") && message.includes("not found")) {
    return "ollama_model_missing";
  }
  if (message.includes("aborted") || message.includes("AbortError")) {
    return "timeout";
  }
  return "unknown";
}

export async function* runCryptoAgentStream(
  input: z.infer<typeof chatRequestSchema>
): AsyncGenerator<AgentEvent, void, void> {
  const model = input.model ?? config.OLLAMA_MODEL;
  const messages = toOllamaMessages(input.messages);
  const toolTrace: ToolTrace[] = [];
  let lastAssistantContent = "";

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      let assistantContent = "";
      const aggregatedToolCalls: OllamaToolCall[] = [];
      let inThinkBlock = false;

      for await (const chunk of streamOllamaChat(model, messages)) {
        const piece = chunk.message?.content ?? "";
        if (piece) {
          assistantContent += piece;
          let visible = piece;
          if (inThinkBlock) {
            const close = visible.indexOf("</think>");
            if (close === -1) {
              visible = "";
            } else {
              visible = visible.slice(close + "</think>".length);
              inThinkBlock = false;
            }
          }
          if (visible) {
            const open = visible.indexOf("<think>");
            if (open !== -1) {
              const before = visible.slice(0, open);
              const afterOpen = visible.slice(open + "<think>".length);
              const close = afterOpen.indexOf("</think>");
              if (close === -1) {
                inThinkBlock = true;
                visible = before;
              } else {
                visible = before + afterOpen.slice(close + "</think>".length);
              }
            }
          }
          if (visible) {
            yield { type: "delta", content: visible };
          }
        }
        if (chunk.message?.tool_calls?.length) {
          aggregatedToolCalls.push(...chunk.message.tool_calls);
        }
        if (chunk.done) break;
      }

      const cleanedAssistant = stripThinking(assistantContent);
      lastAssistantContent = cleanedAssistant;

      messages.push({
        role: "assistant",
        content: cleanedAssistant,
        tool_calls: aggregatedToolCalls.length ? aggregatedToolCalls : undefined
      });

      if (aggregatedToolCalls.length === 0) {
        yield {
          type: "done",
          content:
            cleanedAssistant ||
            "I could not produce a useful answer from the local model response.",
          model,
          toolTrace
        };
        return;
      }

      for (const call of aggregatedToolCalls) {
        const name = call.function.name;
        const args = (call.function.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await runTool(name, args);
          const trace: ToolTrace = { name, arguments: args, result };
          toolTrace.push(trace);
          yield { type: "tool", trace };
          messages.push({
            role: "tool",
            tool_name: name,
            content: JSON.stringify({ ok: true, data: result })
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool failed";
          const trace: ToolTrace = { name, arguments: args, result: { ok: false, error: message } };
          toolTrace.push(trace);
          yield { type: "tool", trace };
          messages.push({
            role: "tool",
            tool_name: name,
            content: JSON.stringify({ ok: false, error: message })
          });
        }
      }
    }

    yield {
      type: "done",
      content:
        lastAssistantContent ||
        "I reached the maximum number of tool calls for this question. Please narrow the request and try again.",
      model,
      toolTrace
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected agent error";
    yield { type: "error", message, kind: classifyError(message) };
  }
}

export async function warmupOllama(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(ollamaChatUrl(), {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        messages: [{ role: "user", content: "ready" }],
        stream: false,
        think: false,
        keep_alive: "5m",
        options: { num_predict: 1, temperature: 0 }
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`warmup failed ${response.status}: ${body.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
