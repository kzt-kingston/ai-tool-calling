import { z } from "zod";
import { config } from "./config.js";
import { toolDefinitions, runTool, type ToolTrace } from "./cryptoTools.js";
import { fetchJson } from "./http.js";

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

type OllamaChatResponse = {
  message: {
    role: "assistant";
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
};

const systemPrompt = [
  "You are a crypto research assistant running locally through Ollama.",
  "Use tools for current crypto prices, trending coins, Binance pair prices, and fuzzy coin search.",
  "Do not invent live prices. If a price or coin is current, use a tool.",
  "When users give a ticker or fuzzy name, search first unless the CoinGecko ID is obvious.",
  "Keep answers concise, cite whether data came from CoinGecko or Binance, and include timestamps when available.",
  "Return only the final answer. Never include hidden reasoning, chain-of-thought, or <think> tags.",
  "This is research only, not financial advice. Do not recommend trades or promise returns."
].join(" ");

const MAX_TOOL_ROUNDS = 5;

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

async function callOllama(model: string, messages: OllamaMessage[]): Promise<OllamaChatResponse> {
  return await fetchJson<OllamaChatResponse>(ollamaChatUrl(), {
    method: "POST",
    timeoutMs: 60_000,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      tools: toolDefinitions,
      stream: false,
      think: false,
      keep_alive: "5m",
      options: {
        temperature: 0.2
      }
    })
  });
}

export async function runCryptoAgent(input: z.infer<typeof chatRequestSchema>) {
  const model = input.model ?? config.OLLAMA_MODEL;
  const messages = toOllamaMessages(input.messages);
  const toolTrace: ToolTrace[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await callOllama(model, messages);
    const assistantMessage = response.message;
    const toolCalls = assistantMessage.tool_calls ?? [];
    const assistantContent = stripThinking(assistantMessage.content ?? "");

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: toolCalls
    });

    if (toolCalls.length === 0) {
      return {
        role: "assistant" as const,
        content:
          assistantContent ||
          "I could not produce a useful answer from the available local model response.",
        model,
        toolTrace
      };
    }

    for (const call of toolCalls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};

      try {
        const result = await runTool(name, args);
        toolTrace.push({ name, arguments: args, result });
        messages.push({
          role: "tool",
          tool_name: name,
          content: JSON.stringify({ ok: true, data: result })
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        toolTrace.push({ name, arguments: args, result: { ok: false, error: message } });
        messages.push({
          role: "tool",
          tool_name: name,
          content: JSON.stringify({ ok: false, error: message })
        });
      }
    }
  }

  return {
    role: "assistant" as const,
    content:
      "I reached the maximum number of tool calls for this question. Please narrow the request and try again.",
    model,
    toolTrace
  };
}
