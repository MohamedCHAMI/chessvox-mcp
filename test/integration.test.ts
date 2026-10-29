import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ChessVoxClient, type FetchLike } from "../src/client.js";
import { buildServer } from "../src/server.js";

const DAILY = {
  dayUtc: new Date().toISOString().slice(0, 10),
  puzzle: { id: "a94c87e4", fen: "6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", moves: ["d1d8"], rating: 666 },
  completed: false,
  completedAt: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("MCP protocol: list tools with annotations, call one end to end", async () => {
  let fetchCalls = 0;
  const impl: FetchLike = async () => {
    fetchCalls += 1;
    return jsonResponse(DAILY);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    buildServer(new ChessVoxClient({ fetchImpl: impl })).connect(serverTransport),
  ]);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "chessvox_daily_puzzle",
      "chessvox_mate_rush_puzzles",
      "chessvox_starter_repertoires",
    ]
  );

  const daily = tools.find((t) => t.name === "chessvox_daily_puzzle")!;
  assert.equal(daily.annotations?.readOnlyHint, true);
  assert.equal(daily.annotations?.openWorldHint, true);

  const result = await client.callTool({ name: "chessvox_daily_puzzle", arguments: {} });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse((result.content as { type: "text"; text: string }[])[0]!.text);
  assert.equal(payload.fen, DAILY.puzzle.fen);
  assert.deepEqual(payload.solutionUci, ["d1d8"]);
  assert.equal(fetchCalls, 1);
  await client.close();
});
