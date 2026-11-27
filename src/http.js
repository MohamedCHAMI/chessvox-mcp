#!/usr/bin/env node
// chessvox-mcp HTTP entry point (streamable HTTP, stateless mode).
// Run: CHESSVOX_MCP_PORT=3964 npx chessvox-mcp --http   (or node src/http.js)
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const port = Number(process.env.CHESSVOX_MCP_PORT || 3964);
const server = createServer();

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== "POST" || url.pathname !== "/mcp") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  // Stateless mode: one transport per request, no session to leak.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.listen(port, () => {
  console.log(`chessvox-mcp listening on http://localhost:${port}/mcp`);
});
