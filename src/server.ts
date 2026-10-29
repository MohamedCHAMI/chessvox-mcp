import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ChessVoxClient } from "./client.js";
import { createTools } from "./tools.js";

/**
 * Wires the ChessVox tools into an MCP server. Kept separate from the
 * bin entry so tests can drive a real server over an in-memory transport.
 */
export function buildServer(client: ChessVoxClient): McpServer {
  const server = new McpServer({
    name: "chessvox-mcp",
    title: "ChessVox",
    version: "1.0.0",
  });

  for (const tool of createTools(client)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
      },
      (args, extra) => tool.handler(args as Record<string, unknown>, { signal: extra?.signal })
    );
  }

  return server;
}
