#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ChessVoxClient } from "./client.js";
import { createTools } from "./tools.js";

const server = new McpServer({
  name: "chessvox-mcp",
  version: "1.0.0",
});

const client = new ChessVoxClient();

for (const tool of createTools(client)) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
    (args) => tool.handler(args as Record<string, unknown>)
  );
}

await server.connect(new StdioServerTransport());
