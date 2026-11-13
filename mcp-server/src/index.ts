#!/usr/bin/env node
/**
 * PassagePort MCP server (stdio transport).
 *
 * stdout carries the MCP protocol, so all diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PassagePortClient, PassagePortError } from "./api-client.js";
import { ConfigError, SERVER_NAME, SERVER_VERSION, loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.error(`${SERVER_NAME} MCP server v${SERVER_VERSION}`);
  console.error(`API: ${config.apiUrl} (token ${config.apiToken ? "set" : "not set"})`);
  for (const warning of config.warnings) console.error(`Warning: ${warning}`);

  const client = new PassagePortClient({
    baseUrl: config.apiUrl,
    token: config.apiToken,
    timeoutMs: config.timeoutMs,
  });

  // The backend may be started after the MCP client, so an unreachable API is not fatal here;
  // each tool call reports the problem itself.
  try {
    await client.health();
    console.error("API reachable.");
  } catch (error) {
    const reason = error instanceof PassagePortError ? error.message : "unknown error";
    console.error(`Warning: API not reachable yet: ${reason}`);
  }

  await createServer(client).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
  } else {
    console.error("Fatal error:", error instanceof Error ? error.name : "unknown");
  }
  process.exit(1);
});
