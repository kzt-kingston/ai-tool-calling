import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import {
  chatRequestSchema,
  runCryptoAgentStream,
  warmupOllama,
  type AgentEvent
} from "./ollamaAgent.js";

const app = Fastify({
  logger: true,
  bodyLimit: 128 * 1024
});

await app.register(cors, {
  origin: config.CLIENT_ORIGIN,
  methods: ["GET", "POST"]
});

await app.register(rateLimit, {
  max: 30,
  timeWindow: "1 minute"
});

app.get("/api/health", async () => ({
  ok: true,
  model: config.OLLAMA_MODEL
}));

app.post("/api/chat", async (request, reply) => {
  let body: ReturnType<typeof chatRequestSchema.parse>;
  try {
    body = chatRequestSchema.parse(request.body);
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Invalid request",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }
    throw error;
  }

  reply.raw.setHeader("content-type", "application/x-ndjson");
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  reply.raw.setHeader("connection", "keep-alive");
  reply.raw.setHeader("x-accel-buffering", "no");
  reply.hijack();
  reply.raw.flushHeaders?.();

  const writeEvent = (event: AgentEvent) => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`${JSON.stringify(event)}\n`);
  };

  const onClose = () => {
    request.log.warn("client disconnected before chat completed");
  };
  reply.raw.once("close", onClose);

  try {
    for await (const event of runCryptoAgentStream(body)) {
      writeEvent(event);
      if (event.type === "error" || event.type === "done") {
        break;
      }
    }
  } catch (error) {
    request.log.error(error);
    const message = error instanceof Error ? error.message : "Unexpected server error";
    writeEvent({ type: "error", message, kind: "unknown" });
  } finally {
    reply.raw.off("close", onClose);
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }
});

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  void warmupOllama()
    .then(() => app.log.info({ model: config.OLLAMA_MODEL }, "ollama warmup complete"))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      app.log.warn({ err: message }, "ollama warmup failed (the first chat will pay the cold-start cost)");
    });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
