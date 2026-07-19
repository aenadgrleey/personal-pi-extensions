import assert from "node:assert/strict";
import { test } from "bun:test";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { __testUtils as cursorBridgeTestUtils } from "pi-cursor-sdk/src/cursor-pi-tool-bridge.ts";

import {
  configureCursorPiToolBridge,
  isCursorSdkWriteIterableClosedError,
} from "./index.ts";

test("cursor SDK write-closed guard", () => {
  const sdkStack = [
    "Error: WritableIterable is closed",
    "    at write (file:///Users/aenadgrleey/repos/mics/personal-pi-extensions/node_modules/@cursor/sdk/dist/cjs/index.js:1:1)",
  ].join("\n");

  assert.equal(
    isCursorSdkWriteIterableClosedError({
      name: "WriteIterableClosedError",
      message: "WritableIterable is closed",
      stack: sdkStack,
    }),
    true,
  );

  assert.equal(
    isCursorSdkWriteIterableClosedError({
      name: "WriteIterableClosedError",
      message: "WritableIterable is closed",
      stack:
        "Error: WritableIterable is closed\n    at write (file:///tmp/other.js:1:1)",
    }),
    false,
  );

  assert.equal(
    isCursorSdkWriteIterableClosedError({
      name: "Error",
      message: "Some other SDK error",
      stack: sdkStack,
    }),
    false,
  );
});

test("Cursor Pi bridge exposes the active workflow tool surface by default", () => {
  const env: Record<string, string | undefined> = {};

  configureCursorPiToolBridge(env);

  assert.deepEqual(env, {
    PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1",
    PI_CURSOR_PI_TOOL_BRIDGE: "1",
  });
});

test("Cursor Pi bridge respects explicit user configuration", () => {
  const env: Record<string, string | undefined> = {
    PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0",
    PI_CURSOR_PI_TOOL_BRIDGE: "0",
  };

  configureCursorPiToolBridge(env);

  assert.deepEqual(env, {
    PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0",
    PI_CURSOR_PI_TOOL_BRIDGE: "0",
  });
});

test("Cursor Pi bridge publishes workflow and built-in tools over MCP", async () => {
  const env: Record<string, string | undefined> = {};
  configureCursorPiToolBridge(env);
  const registry = cursorBridgeTestUtils.createRegistry(
    {
      getActiveTools() {
        return ["workflow", "bash"];
      },
      getAllTools() {
        return [
          {
            name: "workflow",
            description: "Run a Pi workflow",
            parameters: { type: "object" },
          },
          {
            name: "bash",
            description: "Run a shell command",
            parameters: { type: "object" },
          },
        ];
      },
    },
    env,
  );
  const run = await registry.createRun();
  const endpoint = run.mcpServers?.pi_tools?.url;
  const client = new McpClient({
    name: "cursor-bridge-test",
    version: "1.0.0",
  });

  try {
    assert.equal(run.enabled, true);
    assert.deepEqual(
      run.snapshot.tools.map((tool) => tool.mcpToolName),
      ["pi__workflow", "pi__bash"],
    );
    assert.match(endpoint ?? "", /^http:\/\/127\.0\.0\.1:\d+\//);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!)));
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["pi__workflow", "pi__bash"],
    );
  } finally {
    await client.close();
    await run.dispose();
  }
});
