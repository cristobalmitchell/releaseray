/**
 * A local OpenAI-compatible endpoint for the quickstart scenario. Every
 * `POST /v1/chat/completions` gets the recorded response in
 * test/fixtures/providers/openai-chat-completion.json, so the real `openai`
 * adapter runs end to end at no cost.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "providers",
  "openai-chat-completion.json"
);

/** A request the stub received. */
export interface StubRequest {
  path: string;
  authorization: string;
  body: Record<string, unknown>;
}

/** The stub server. */
export class OpenAIStub {
  readonly requests: StubRequest[] = [];
  private server: Server | null = null;
  private readonly response: Record<string, unknown>;

  constructor() {
    const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    delete recorded._source;
    this.response = recorded;
  }

  /** The draft the recorded response carries. */
  get content(): string {
    const choices = this.response.choices as Array<{ message: { content: string } }>;
    return choices[0].message.content;
  }

  /** Starts listening; returns the base URL for `llm.baseUrl`. */
  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const path = (req.url ?? "").split("?")[0];
      this.requests.push({
        path,
        authorization: req.headers.authorization ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
      });
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.response));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  /** Stops listening. */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
