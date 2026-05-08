import { StrictMode } from "react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  CircleAlert,
  Coins,
  Loader2,
  Search,
  Send,
  Sparkles,
  User
} from "lucide-react";
import "./styles.css";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  toolTrace?: ToolTrace[];
};

type ToolTrace = {
  name: string;
  arguments: unknown;
  result: unknown;
};

const examples = [
  "What is the current price of bitcoin and ethereum?",
  "Find coins related to solana and show the top matches.",
  "What crypto coins are trending right now?",
  "What is the Binance BTCUSDT price?"
];

const initialMessages: ChatMessage[] = [
  {
    id: crypto.randomUUID(),
    role: "assistant",
    content:
      "Ask me to research crypto prices, search coins, compare assets, or check trending coins. I use a local Ollama model and call only allowlisted public market-data tools."
  }
];

function compactJson(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}

function stripThinking(content: string) {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function friendlyErrorMessage(raw: string, kind?: string) {
  if (kind === "ollama_unreachable") {
    return "Could not reach Ollama. Make sure `ollama serve` is running on the configured port.";
  }
  if (kind === "ollama_model_missing") {
    return "Ollama model not found. Pull the configured model (e.g. `ollama pull qwen3:4b`) or set OLLAMA_MODEL in .env.";
  }
  if (kind === "timeout") {
    return "The local model went idle for too long. Try a shorter question or a smaller model (e.g. qwen2.5:3b).";
  }
  return raw;
}

function ToolTracePanel({ traces }: { traces: ToolTrace[] }) {
  if (traces.length === 0) {
    return null;
  }

  return (
    <details className="tool-trace">
      <summary>
        <Activity size={15} />
        <span>{traces.length} tool call{traces.length === 1 ? "" : "s"}</span>
      </summary>
      <div className="tool-list">
        {traces.map((trace, index) => (
          <section className="tool-call" key={`${trace.name}-${index}`}>
            <div className="tool-call-title">
              <Search size={14} />
              <span>{trace.name}</span>
            </div>
            <pre>{compactJson({ arguments: trace.arguments, result: trace.result })}</pre>
          </section>
        ))}
      </div>
    </details>
  );
}

function MessageBubble({ message, pending }: { message: ChatMessage; pending?: boolean }) {
  const isUser = message.role === "user";
  const Icon = isUser ? User : Bot;
  const showThinkingDots = pending && !message.content;

  return (
    <article className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      <div className="avatar" aria-hidden="true">
        <Icon size={18} />
      </div>
      <div className={`bubble ${showThinkingDots ? "thinking-bubble" : ""}`}>
        {showThinkingDots ? (
          <>
            <span>Thinking</span>
            <span className="thinking-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </>
        ) : (
          <p>{message.content}</p>
        )}
        <ToolTracePanel traces={message.toolTrace ?? []} />
      </div>
    </article>
  );
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading, error]);

  const visibleConversation = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map(({ role, content }) => ({ role, content }));

  async function submitMessage(nextInput = input) {
    const content = nextInput.trim();

    if (!content || isLoading) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content
    };
    const assistantId = crypto.randomUUID();

    setInput("");
    setError(null);
    setIsLoading(true);
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "", toolTrace: [] }
    ]);

    let assistantBuffer = "";
    let assistantTraces: ToolTrace[] = [];

    const updateAssistant = (next: Partial<ChatMessage>) => {
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, ...next } : message))
      );
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson"
        },
        body: JSON.stringify({
          messages: [...visibleConversation, userMessage].slice(-16)
        })
      });

      if (!response.ok) {
        let errorText = `Request failed (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: string; details?: unknown };
          if (payload?.error) {
            errorText = typeof payload.details === "string"
              ? `${payload.error}: ${payload.details}`
              : payload.error;
          }
        } catch {
          // body wasn't JSON
        }
        throw new Error(errorText);
      }

      if (!response.body) {
        throw new Error("Server returned an empty response");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            try {
              const event = JSON.parse(line) as
                | { type: "delta"; content: string }
                | { type: "tool"; trace: ToolTrace }
                | { type: "done"; content: string; model: string; toolTrace: ToolTrace[] }
                | { type: "error"; message: string; kind?: string };

              if (event.type === "delta") {
                assistantBuffer += event.content;
                updateAssistant({ content: stripThinking(assistantBuffer) });
              } else if (event.type === "tool") {
                assistantTraces = [...assistantTraces, event.trace];
                updateAssistant({ toolTrace: assistantTraces });
              } else if (event.type === "done") {
                assistantBuffer = event.content;
                assistantTraces = event.toolTrace ?? assistantTraces;
                updateAssistant({
                  content: stripThinking(event.content),
                  toolTrace: assistantTraces
                });
              } else if (event.type === "error") {
                streamError = friendlyErrorMessage(event.message, event.kind);
              }
            } catch {
              // skip malformed line
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Something went wrong.";
      setError(message);
      setMessages((current) => {
        const target = current.find((m) => m.id === assistantId);
        if (target && !target.content) {
          return current.filter((m) => m.id !== assistantId);
        }
        return current;
      });
    } finally {
      setIsLoading(false);
    }
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage();
  }

  return (
    <main className="app-shell">
      <section className="side-panel" aria-label="Research context">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Coins size={22} />
          </div>
          <div>
            <h1>Crypto AI Research</h1>
            <p>Local Ollama agent with public market-data tools</p>
          </div>
        </div>

        <div className="status-card">
          <div>
            <span className="status-dot" />
            <strong>Backend tool loop</strong>
          </div>
          <p>CoinGecko search, CoinGecko price data, trending coins, and Binance pair prices.</p>
        </div>

        <div className="example-list">
          <div className="section-label">
            <Sparkles size={15} />
            <span>Try a prompt</span>
          </div>
          {examples.map((example) => (
            <button
              className="example-button"
              disabled={isLoading}
              key={example}
              onClick={() => void submitMessage(example)}
              type="button"
            >
              {example}
            </button>
          ))}
        </div>

        <p className="disclaimer">Research only. The app does not expose trading or wallet actions.</p>
      </section>

      <section className="chat-panel" aria-label="Crypto chat">
        <div className="messages">
          {messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            return (
              <MessageBubble
                key={message.id}
                message={message}
                pending={isLoading && isLast && message.role === "assistant"}
              />
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {error ? (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
          </div>
        ) : null}

        <form className="composer" onSubmit={onSubmit}>
          <input
            aria-label="Message"
            disabled={isLoading}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about BTC, ETH, trending coins, or fuzzy coin names..."
            value={input}
          />
          <button aria-label="Send message" disabled={isLoading || !input.trim()} type="submit">
            {isLoading ? <Loader2 className="spin" size={20} /> : <Send size={20} />}
          </button>
        </form>
      </section>
    </main>
  );
}

const container = document.getElementById("root")!;
const root = createRoot(container);

root.render(
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => root.unmount());
}
