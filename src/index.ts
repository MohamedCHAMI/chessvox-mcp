#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ChessVoxClient } from "./client.js";
import { buildServer } from "./server.js";

const server = buildServer(new ChessVoxClient());

await server.connect(new StdioServerTransport());
