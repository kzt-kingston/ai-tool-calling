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

type ChatResponse = {
  role: "assistant";
  content: string;
  model: string;
  toolTrace: ToolTrace[];
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const Icon = isUser ? User : Bot;

  return (
    <article className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      <div className="avatar" aria-hidden="true">
        <Icon size={18} />
      </div>
      <div className="bubble">
        <p>{message.content}</p>
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

    setInput("");
    setError(null);
    setIsLoading(true);
    setMessages((current) => [...current, userMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messages: [...visibleConversation, userMessage].slice(-16)
        })
      });

      const payload = (await response.json()) as ChatResponse | { error: string; details?: string };

      if (!response.ok) {
        if ("error" in payload) {
          throw new Error(payload.details ? `${payload.error}: ${payload.details}` : payload.error);
        }

        throw new Error("Request failed");
      }

      const assistantPayload = payload as ChatResponse;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: stripThinking(assistantPayload.content),
          toolTrace: assistantPayload.toolTrace
        }
      ]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Something went wrong.";
      setError(message);
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
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {isLoading ? (
            <article className="message message-assistant">
              <div className="avatar" aria-hidden="true">
                <Bot size={18} />
              </div>
              <div className="bubble thinking-bubble" aria-live="polite">
                <span>Thinking</span>
                <span className="thinking-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </article>
          ) : null}
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
