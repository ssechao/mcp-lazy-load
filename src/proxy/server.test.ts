import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyServer } from "./server.js";
import { ServerLoader } from "./loader.js";
import { ToolRegistry, type ToolEntry } from "./registry.js";

const schema = {
  type: "object",
  properties: {
    peer_id: { type: "string", minLength: 1, description: "Destination ID or title" },
    message: { type: "string", minLength: 1 },
  },
  required: ["peer_id", "message"],
  additionalProperties: false,
};

describe("proxy tool contracts over MCP", () => {
  let registry: ToolRegistry;
  let client: Client;
  let server: Awaited<ReturnType<typeof createProxyServer>>;
  let listTools: ReturnType<typeof vi.fn>;
  let callTool: ReturnType<typeof vi.fn>;
  let getClient: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    registry = new ToolRegistry();
    registry.addTool({
      name: "send",
      description: "Stale cached description",
      server: "probe",
      serverDescription: "Test server",
      inputSchema: { type: "object" },
      keywords: ["send"],
    });
    listTools = vi.fn(async () => ({
      tools: [{ name: "send", description: "Live description", inputSchema: schema }],
    }));
    callTool = vi.fn(async () => ({ content: [{ type: "text", text: "sent" }] }));
    const loader = new ServerLoader({ probe: { command: "not-started", args: [] } });
    getClient = vi.spyOn(loader, "getClient").mockResolvedValue({ listTools, callTool } as unknown as Client);
    server = await createProxyServer(registry, loader);
    client = new Client({ name: "contract-test", version: "0" });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    await client.connect(local);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  });

  async function execute(argumentsValue: Record<string, unknown>) {
    try {
      return await client.callTool({ name: "mcp_execute_tool", arguments: argumentsValue });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  }

  async function search() {
    const result = await client.callTool({ name: "mcp_search_tools", arguments: { query: "send" } });
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text);
  }

  it("describes the nesting and exposes the live input schema through search", async () => {
    const definitions = await client.listTools();
    const executeDefinition = definitions.tools.find((tool) => tool.name === "mcp_execute_tool")!;
    expect(executeDefinition.description).toContain("arguments.peer_id");
    expect(executeDefinition.description).toContain('"arguments"');
    const result = await search();
    expect(result.results[0].inputSchema).toEqual(schema);
    expect(result.results[0].description).toBe("Live description");
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([
    { arguments: { message: "report" } },
    { peer_id: "target", arguments: { message: "report" } },
    { arguments: { peer_id: "target" } },
    {},
    { arguments: { peer_id: 42, message: "report" } },
    { arguments: { peer_id: "", message: "report" } },
    { arguments: { peer_id: "target", message: "report", extra: true } },
  ])("rejects incomplete or malformed inputs before executing: %j", async (inputs) => {
    const result = await execute({ server_name: "probe", tool_name: "send", ...inputs });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("arguments");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects misplaced root fields even when the nested parameters are valid", async () => {
    const result = await execute({
      server_name: "probe", tool_name: "send", peer_id: "wrong",
      arguments: { peer_id: "right", message: "report" },
    });
    expect(result.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reports the required schema without calling the tool or echoing the message", async () => {
    const result = await execute({
      server_name: "probe", tool_name: "send", arguments: { message: "PRIVATE_PAYLOAD" },
    });
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain("peer_id");
    expect(text).not.toContain("PRIVATE_PAYLOAD");
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(["target-id", "Destination Title"])("forwards valid nested inputs once and unchanged: %s", async (peer_id) => {
    const argumentsValue = { peer_id, message: "report\nwith Unicode é" };
    const result = await execute({ server_name: "probe", tool_name: "send", arguments: argumentsValue });
    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith({ name: "send", arguments: argumentsValue });
  });

  it("keeps no-argument tools compatible", async () => {
    listTools.mockResolvedValue({ tools: [{ name: "send", inputSchema: { type: "object" } }] });
    const result = await execute({ server_name: "probe", tool_name: "send" });
    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith({ name: "send", arguments: {} });
  });

  it("shares catalog discovery across concurrent search and execution", async () => {
    await Promise.all([
      search(),
      execute({ server_name: "probe", tool_name: "send", arguments: { peer_id: "target", message: "report" } }),
    ]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("refreshes a catalog when the backend client has changed", async () => {
    await search();
    const nextList = vi.fn(async () => ({
      tools: [{ name: "send", description: "Replacement description", inputSchema: schema }],
    }));
    getClient.mockResolvedValue({ listTools: nextList, callTool } as unknown as Client);
    expect((await search()).results[0].description).toBe("Replacement description");
    expect(nextList).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired live catalog without reconnecting the backend", async () => {
    await search();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    listTools.mockResolvedValue({
      tools: [{ name: "send", description: "Updated while connected", inputSchema: schema }],
    });
    expect((await search()).results[0].description).toBe("Updated while connected");
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("reads every page of the live tool catalog", async () => {
    listTools
      .mockResolvedValueOnce({ tools: [], nextCursor: "page-two" })
      .mockResolvedValueOnce({ tools: [{ name: "send", inputSchema: schema }] });
    expect((await search()).results[0].inputSchema).toEqual(schema);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "page-two" });
  });

  it("preserves backend tool errors without retrying", async () => {
    callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "Refused" }] });
    const result = await execute({
      server_name: "probe", tool_name: "send",
      arguments: { peer_id: "target", message: "report" },
    });
    expect(result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not expose stale schemas as live when discovery fails", async () => {
    listTools.mockRejectedValue(new Error("backend unavailable"));
    const result = await search();
    expect(result.results).toEqual([]);
    expect(result.errors[0].server_name).toBe("probe");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("uses the live required fields rather than a stale stricter schema", async () => {
    (registry.findTool("send", "probe") as ToolEntry).inputSchema = {
      type: "object", required: ["obsolete"],
    };
    const result = await execute({
      server_name: "probe", tool_name: "send",
      arguments: { peer_id: "target", message: "report" },
    });
    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("never retries an executed tool after an ambiguous transport failure", async () => {
    callTool.mockRejectedValue(new Error("Connection closed"));
    const result = await execute({
      server_name: "probe", tool_name: "send",
      arguments: { peer_id: "target", message: "report" },
    });
    expect(result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
