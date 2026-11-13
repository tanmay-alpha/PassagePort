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

const PROBE_TIMEOUT_MS = 3000;

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

  await createServer(client).connect(new StdioServerTransport());

  // Diagnostic only, and deliberately not awaited: MCP initialization must never wait for the
  // backend, which may be slow, stalled or started later. Tool calls report failures themselves.
  const probe = new PassagePortClient({
    baseUrl: config.apiUrl,
    token: config.apiToken,
    timeoutMs: Math.min(config.timeoutMs, PROBE_TIMEOUT_MS),
  });
  probe.health().then(
    () => console.error("API reachable."),
    (error: unknown) => {
      const reason = error instanceof PassagePortError ? error.message : "unknown error";
      console.error(`Warning: API not reachable yet: ${reason}`);
    },
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
  } else {
    console.error("Fatal error:", error instanceof Error ? error.name : "unknown");
  }
  process.exit(1);
});
