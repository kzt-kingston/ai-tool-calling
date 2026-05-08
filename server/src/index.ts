import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { chatRequestSchema, runCryptoAgent } from "./ollamaAgent.js";

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
  try {
    const body = chatRequestSchema.parse(request.body);
    return await runCryptoAgent(body);
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

    request.log.error(error);

    const message = error instanceof Error ? error.message : "Unexpected server error";
    const isOllamaConnectionIssue =
      message.includes("ECONNREFUSED") || message.includes("fetch failed");
    const isMissingOllamaModel = message.includes("model '") && message.includes("not found");

    return reply.status(isOllamaConnectionIssue || isMissingOllamaModel ? 503 : 500).send({
      error: isMissingOllamaModel
        ? "Ollama model not found. Pull the configured model or set OLLAMA_MODEL in .env."
        : isOllamaConnectionIssue
        ? "Could not reach Ollama. Make sure Ollama is running and the model is pulled."
        : "Chat request failed",
      details: message
    });
  }
});

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
