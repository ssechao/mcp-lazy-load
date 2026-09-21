import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ServerLoader } from "./loader.js";

const require = createRequire(import.meta.url);
const serverModule = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
const transportModule = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
const child = `
import { McpServer } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(transportModule)};
const server = new McpServer({ name: "isolated-loader-test", version: "0" });
server.tool("probe", {}, async () => ({ content: [{ type: "text", text: "OK" }] }));
await server.connect(new StdioServerTransport());
`;

describe("loader reconnects closed child transports", () => {
  let loader: ServerLoader;

  afterEach(async () => {
    await loader?.closeAll();
  });

  function setup() {
    loader = new ServerLoader({
      probe: { command: process.execPath, args: ["--input-type=module", "-e", child] },
    });
  }

  it("replaces a closed child on the next request and deduplicates concurrent loads", async () => {
    setup();
    const first = await loader.getClient("probe");
    expect((await first.callTool({ name: "probe", arguments: {} })).isError).not.toBe(true);
    await first.close();
    expect(loader.isLoaded("probe")).toBe(false);

    const [second, concurrent] = await Promise.all([
      loader.getClient("probe"),
      loader.getClient("probe"),
    ]);
    expect(second).not.toBe(first);
    expect(concurrent).toBe(second);
    const result = await second.callTool({ name: "probe", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "OK" }]);
  });

  it("does not let an old close notification remove the replacement client", async () => {
    setup();
    const first = await loader.getClient("probe");
    const oldClose = first.onclose;
    await first.close();
    const second = await loader.getClient("probe");
    oldClose?.();
    expect(second).not.toBe(first);
    expect(loader.isLoaded("probe")).toBe(true);
    expect(await loader.getClient("probe")).toBe(second);
  });
});
