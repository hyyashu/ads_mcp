import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Authenticator } from "../auth/context";
import type { AppConfig } from "../config";
import type { WebRoutes } from "../web/routes";
import { ToolError } from "./errors";
import type { PipelineDeps } from "./pipeline";
import { createMcpServer } from "./server";

export interface HttpOptions {
  config: Pick<AppConfig, "issuer" | "allowedOrigins">;
  maxBodyBytes?: number;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new ToolError("invalid_argument", "Request body too large.");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * HTTP surface:
 *  - /mcp: the MCP resource server (Streamable HTTP, stateless). Requires an OAuth access token or API token.
 *  - OAuth discovery/registration/authorize/token/revoke for MCP clients, and the human web pages (login, approvals,
 *    connections), are handled by WebRoutes.
 * Approvals are never reachable with a bearer token: only a human browser session (with CSRF protection) can decide.
 */
export function createHttpServer(deps: PipelineDeps, authn: Authenticator, opts: HttpOptions, web: WebRoutes): Server {
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const challenge = (scope = "ads:read") => `Bearer realm="ads-mcp", resource_metadata="${opts.config.issuer}/.well-known/oauth-protected-resource", scope="${scope}"`;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });

      if (url.pathname !== "/mcp") {
        if (await web.handle(req, res, url)) return;
        return json(res, 404, { error: "not found" });
      }

      // ---- /mcp ----
      const origin = req.headers.origin;
      if (origin && !opts.config.allowedOrigins.includes(origin)) return json(res, 403, { error: "origin not allowed" });
      const cors: Record<string, string> = origin
        ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, accept", "access-control-allow-methods": "POST, OPTIONS", "access-control-expose-headers": "www-authenticate" }
        : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return void res.end();
      }

      const auth = await authn.authenticate(req.headers);
      if (!auth) return json(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge(), ...cors });

      if (req.method !== "POST") {
        return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: use POST." }, id: null }, { allow: "POST", ...cors });
      }
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      const body = await readBody(req, maxBody);
      const server = createMcpServer(deps, auth);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      return await transport.handleRequest(req, res, body);
    } catch (e) {
      if (e instanceof ToolError) return json(res, 400, { error: e.message });
      if (e instanceof SyntaxError) return json(res, 400, { error: "invalid JSON" });
      console.error("[http] unhandled:", e instanceof Error ? e.message : e);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });
}
