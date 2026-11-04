import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "../auth/context";
import { catalogInstructions, tenantCapabilities, visibleTools } from "./catalog";
import { type PipelineDeps, runTool } from "./pipeline";
import { type AnyTool, riskOf } from "./tool";

export const SERVER_INFO = { name: "ads-mcp", version: "0.1.0" } as const;

/**
 * One McpServer per request (stateless): the caller's identity is bound into every tool callback, and only the tools this
 * caller can use are registered (see catalog.ts). The server sends no tools/list_changed notifications (it keeps no
 * sessions); a client sees newly connected platforms when it lists tools again.
 */
export async function createMcpServer(deps: PipelineDeps, auth: AuthContext, requestId?: string): Promise<McpServer> {
  const caps = await tenantCapabilities(deps.db, auth.tenantId);
  const server = new McpServer(SERVER_INFO, { instructions: catalogInstructions(caps, auth) });

  for (const tool of visibleTools(deps.registry.list(), auth, caps)) {
    const risk = riskOf(tool);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        // No outputSchema: with every tool's result envelope listed, tools/list for a fully connected workspace was
        // ~1.1 MB (83% output schemas) and ChatGPT failed "action discovery". Results are still validated by the
        // pipeline and returned as structuredContent; the schemas only cost clients context.
        annotations: {
          readOnlyHint: tool.kind === "read",
          destructiveHint: risk === "destructive",
          idempotentHint: tool.kind === "read",
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        const env = await runTool(deps, tool, args, auth, extra.signal, requestId);
        return { content: [{ type: "text" as const, text: JSON.stringify(env) }], structuredContent: env as unknown as Record<string, unknown>, isError: !env.ok };
      },
    );
  }
  return server;
}
