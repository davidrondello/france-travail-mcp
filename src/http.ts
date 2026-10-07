/**
 * Transport Streamable HTTP (mode distant, sans état).
 *
 * Authentification : le point d'entrée MCP est `/<MCP_PATH_SECRET>/mcp`. Sans le
 * bon segment secret, toute requête reçoit un 404 (le serveur ne révèle pas son
 * existence). À servir UNIQUEMENT derrière HTTPS (Caddy).
 *
 * Variables : MCP_PATH_SECRET (obligatoire, >= 32 car.), PORT (défaut 3000),
 * HOST (défaut 0.0.0.0).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 1_000_000;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startHttpServer(buildServer: () => McpServer): void {
  const secret = process.env.MCP_PATH_SECRET ?? "";
  if (secret.length < 32) {
    console.error("[france-travail-mcp] MCP_PATH_SECRET manquant ou trop court (>= 32 caractères).");
    process.exit(1);
  }
  const mcpPath = `/${secret}/mcp`;
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  const httpServer = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];

    // Healthcheck Docker (aucune donnée sensible).
    if (url === "/healthz") return send(res, 200, { status: "ok" });

    if (!safeEqual(url, mcpPath)) return send(res, 404, { error: "not found" });

    // Mode sans état : seul POST est utile (pas de flux SSE serveur → client).
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }

    try {
      const body = await readJson(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("[france-travail-mcp] Erreur requête :", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null });
      }
    }
  });

  httpServer.listen(port, host, () => {
    // Ne jamais journaliser le secret.
    console.error(`[france-travail-mcp] Serveur HTTP démarré sur ${host}:${port} (MCP sur /<secret>/mcp).`);
  });
}
