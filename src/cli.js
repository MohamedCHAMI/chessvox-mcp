#!/usr/bin/env node
// chessvox-mcp stdio entry point. Configure in an MCP client with:
//   { "mcpServers": { "chessvox": { "command": "npx", "args": ["-y", "chessvox-mcp"] } } }
import { createServer } from "./server.js";
import { stopEngine } from "./engine.js";

if (process.argv.includes("--http")) {
  await import("./http.js");
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createServer();
  process.on("exit", stopEngine);
  process.on("SIGINT", () => { stopEngine(); process.exit(0); });
  await server.connect(new StdioServerTransport());
}
