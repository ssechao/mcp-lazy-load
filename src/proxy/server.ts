import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { z } from "zod";
import { ToolRegistry, extractKeywords } from "./registry.js";
import { ServerLoader } from "./loader.js";
import { listServerTools } from "../utils/mcp-client.js";
import { VERSION } from "../version.js";

export async function createProxyServer(
  registry: ToolRegistry,
  loader: ServerLoader
): Promise<McpServer> {
  const server = new McpServer({
    name: "mcp-lazy",
    version: VERSION,
  });
  const catalogs = new WeakMap<Client, { expiresAt: number; pending: Promise<void> }>();

  async function clientWithCatalog(serverName: string): Promise<Client> {
    const client = await loader.getClient(serverName);
    let catalog = catalogs.get(client);
    if (!catalog || catalog.expiresAt <= Date.now()) {
      const fresh = { expiresAt: Infinity, pending: Promise.resolve() };
      fresh.pending = (async () => {
        const tools = await listServerTools(client);
        const serverDescription = registry.getToolsByServer(serverName)[0]?.serverDescription ?? "";
        registry.replaceServerTools(serverName, tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
          server: serverName,
          serverDescription,
          keywords: extractKeywords(tool.name, tool.description ?? ""),
        })));
        fresh.expiresAt = Date.now() + 60_000;
      })();
      catalogs.set(client, fresh);
      catalog = fresh;
    }
    try {
      await catalog.pending;
    } catch (error) {
      if (catalogs.get(client) === catalog) catalogs.delete(client);
      throw error;
    }
    return client;
  }

  server.tool(
    "mcp_search_tools",
    `Search available MCP tools by keyword before calling mcp_execute_tool.
Returns tool_name, server_name, description and the live inputSchema.
The inputSchema describes the object to place INSIDE mcp_execute_tool.arguments.
Supply every field listed in inputSchema.required. Cached entries only select servers;
their descriptions and schemas are refreshed from the live connection before returning.
Example: mcp_search_tools("query database") → postgres-mcp.query_database`,
    {
      query: z.string().describe("What you want to do in natural language"),
      limit: z.number().int().min(1).max(20).optional().default(5).describe("Max results to return (default: 5)"),
    },
    async ({ query, limit }) => {
      const selected = new Set(registry.search(query, limit).map((tool) => tool.server_name));
      const refreshed = new Set<string>();
      const errors: Array<{ server_name: string; error: string }> = [];
      await Promise.all([...selected].map(async (name) => {
        try {
          await clientWithCatalog(name);
          refreshed.add(name);
        } catch (error) {
          errors.push({
            server_name: name,
            error: `Could not refresh tool schemas: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }));
      const results = registry.search(query, limit).filter((tool) => refreshed.has(tool.server_name));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            results,
            errors: errors.length ? errors : undefined,
            suggestion: results.length ? undefined :
              `No verified matching tools. Available servers: ${registry.getServerNames().join(", ")}. Try the server name or check the reported connection error.`,
          }),
        }],
      };
    }
  );

  server.registerTool(
    "mcp_execute_tool",
    { description: `Execute a target MCP tool using its live inputSchema from mcp_search_tools.
Only tool_name, server_name and arguments belong at the top level.
ALL target-tool parameters MUST be nested inside arguments. Supply every required field.
For ht_send_to_peer, both arguments.peer_id (destination ID or title) and arguments.message are required.
Mentioning the destination in the message does not address the tool call.
Correct example:
{"server_name":"llm-aether","tool_name":"ht_send_to_peer","arguments":{"peer_id":"Destination title or ID","message":"Your message"}}
Never use {"peer_id":"...","arguments":{"message":"..."}} or {"arguments":{"message":"..."}}.
Invalid arguments are rejected before executing the target tool. Errors are not retried automatically.`,
    inputSchema: z.object({
      tool_name: z.string().min(1).describe("Target tool_name returned by mcp_search_tools"),
      server_name: z.string().min(1).describe("Target server_name returned by mcp_search_tools"),
      arguments: z.record(z.unknown()).optional().describe(
        "Target-tool parameters matching inputSchema, including ALL required fields. Put peer_id and message HERE for ht_send_to_peer. Omit only if the target tool has no required parameters."
      ),
    }).strict("Put target-tool parameters inside arguments, not at the top level.") },
    async ({ tool_name, server_name, arguments: args }) => {
      if (!loader.hasConfig(server_name)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Server "${server_name}" is not configured.` }) }],
          isError: true,
        };
      }

      try {
        const client = await clientWithCatalog(server_name);
        const tool = registry.findTool(tool_name, server_name);
        if (!tool) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Tool "${tool_name}" not found in live server "${server_name}". Use mcp_search_tools first.`,
              }),
            }],
            isError: true,
          };
        }

        const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
        const validation = validate(args ?? {});
        if (!validation.valid) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Invalid arguments for ${server_name}.${tool_name}: ${validation.errorMessage?.replace(/\bdata\b/g, "arguments")}. Put every target-tool parameter inside arguments.`,
                code: "INVALID_TOOL_ARGUMENTS",
                required_arguments: tool.inputSchema.required ?? [],
                inputSchema: tool.inputSchema,
              }),
            }],
            isError: true,
          };
        }

        const result = await client.callTool({ name: tool_name, arguments: args ?? {} });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: result.isError === true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const alternatives = registry.search(tool_name, 3);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Failed to execute ${tool_name} on ${server_name}: ${message}`,
              alternatives: alternatives.length ? alternatives : undefined,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  return server;
}

export async function startProxyServer(
  registry: ToolRegistry,
  loader: ServerLoader
): Promise<void> {
  const server = await createProxyServer(registry, loader);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await loader.closeAll();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await loader.closeAll();
    process.exit(0);
  });
}
