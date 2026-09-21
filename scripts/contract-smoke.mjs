#!/usr/bin/env node
// End-to-end smoke test of an INSTALLED mcp-lazy release, over a real stdio
// child process. It deliberately seeds a stale tool cache so the test proves
// the installed artifact refreshes the catalog from the live server instead of
// trusting what is on disk, then exercises the argument contract that a model
// actually gets wrong in practice: a destination mentioned in the prose but
// never placed inside `arguments`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const release = process.argv[2];
if (!release) {
  console.error("usage: contract-smoke.mjs <release-dir>");
  process.exit(2);
}

/// The fake backend: one tool with two required string inputs, and one tool
/// that kills its own process so the caller can observe what happens to a
/// request that was already dispatched when the transport died.
function childSource() {
  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "contract-smoke", version: "1" });
let calls = 0;

server.tool("send", "LIVE_SCHEMA", { peer_id: z.string(), message: z.string() }, async (args) => ({
  content: [{ type: "text", text: JSON.stringify({ calls: ++calls, args }) }],
}));

server.tool("crash", {}, async () => {
  process.exit(0);
});

await server.connect(new StdioServerTransport());
`;
}

const sdk = path.join(release, "node_modules/@modelcontextprotocol/sdk/dist/esm");
const { Client } = await import(pathToFileURL(path.join(sdk, "client/index.js")));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "client/stdio.js")));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lazy-contract-smoke-"));
// The child is written outside the release and reaches its dependencies through
// a `node_modules` symlink: ESM resolution walks up from the importing file, so
// this keeps the installed release free of test fixtures.
const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lazy-contract-child-"));
fs.symlinkSync(path.join(release, "node_modules"), path.join(childDir, "node_modules"), "dir");
const childScript = path.join(childDir, "child.mjs");
fs.writeFileSync(childScript, childSource());
const childArgs = [childScript];

fs.mkdirSync(path.join(home, ".mcp-lazy"));
fs.writeFileSync(
  path.join(home, ".mcp-lazy/servers.json"),
  JSON.stringify({ servers: { probe: { command: process.execPath, args: childArgs } } })
);
const fingerprint = createHash("sha256")
  .update(`probe:${process.execPath}:${childArgs.join(",")}`)
  .digest("hex");
fs.writeFileSync(
  path.join(home, ".mcp-lazy/tool-cache.json"),
  JSON.stringify({
    fingerprint,
    tools: [
      {
        name: "send",
        server: "probe",
        description: "OLD_SCHEMA",
        serverDescription: "probe",
        keywords: ["send"],
        inputSchema: { type: "object", required: ["obsolete"] },
      },
    ],
  })
);

const client = new Client({ name: "installed-artifact-test", version: "0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(release, "dist/index.js"), "serve"],
  env: { ...process.env, HOME: home },
  stderr: "pipe",
});
const logs = [];
transport.stderr?.on("data", (chunk) => logs.push(chunk.toString()));

const call = (name, args) => client.callTool({ name, arguments: args });
const text = (result) => result.content[0].text;

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, "0.1.7-weytop.1");

  const found = JSON.parse(text(await call("mcp_search_tools", { query: "send" }))).results[0];
  assert.equal(found.description, "LIVE_SCHEMA", "catalog must come from the live server");
  assert.deepEqual(found.inputSchema.required, ["peer_id", "message"]);
  console.log("PASS stale disk catalog refreshed; required fields exposed");

  const missing = await call("mcp_execute_tool", {
    server_name: "probe",
    tool_name: "send",
    arguments: { message: "PRIVATE_PAYLOAD" },
  });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /peer_id/);
  assert.doesNotMatch(text(missing), /PRIVATE_PAYLOAD/, "the error must not echo the payload");
  console.log("PASS missing destination rejected without echoing input");

  const misplaced = await call("mcp_execute_tool", {
    server_name: "probe",
    tool_name: "send",
    peer_id: "destination",
    arguments: { message: "report" },
  });
  assert.equal(misplaced.isError, true);
  assert.match(text(misplaced), /arguments/);
  console.log("PASS misplaced root destination rejected");

  const valid = {
    server_name: "probe",
    tool_name: "send",
    arguments: { peer_id: "Destination title", message: "report" },
  };
  const sent = JSON.parse(JSON.parse(text(await call("mcp_execute_tool", valid))).content[0].text);
  assert.equal(sent.calls, 1);
  assert.deepEqual(sent.args, valid.arguments);
  console.log("PASS valid call forwarded unchanged, exactly once");

  const crashed = await call("mcp_execute_tool", {
    server_name: "probe",
    tool_name: "crash",
    arguments: {},
  });
  assert.equal(crashed.isError, true, "a dead backend must fail, not silently succeed");

  const recovered = JSON.parse(
    JSON.parse(text(await call("mcp_execute_tool", valid))).content[0].text
  );
  assert.equal(recovered.calls, 1, "the failed call must not have been replayed");
  console.log("PASS closed backend replaced on the next call; failed call not replayed");
} catch (error) {
  console.error("FAIL", error);
  console.error(logs.join(""));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(childDir, { recursive: true, force: true });
}