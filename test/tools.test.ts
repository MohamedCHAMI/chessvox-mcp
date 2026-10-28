import assert from "node:assert/strict";
import test from "node:test";

import { ChessVoxClient, type FetchLike } from "../src/client.js";
import { createTools, validateDay } from "../src/tools.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const DAILY = {
  dayUtc: "2026-10-28",
  puzzle: { id: "a94c87e4", fen: "r1b2rk1/1p3ppn w - - 0 17", moves: ["c2h7"], rating: 666 },
  completed: false,
  completedAt: null,
};

function clientWith(status: number, body: unknown): {
  client: ChessVoxClient;
  urls: string[];
} {
  const urls: string[] = [];
  const impl: FetchLike = async (url) => {
    urls.push(url);
    return status === 200 ? okResponse(body) : new Response("nope", { status });
  };
  return { client: new ChessVoxClient({ fetchImpl: impl }), urls };
}

function text(result: { content: { type: string; text: string }[] }): unknown {
  assert.equal(result.content[0]!.type, "text");
  return JSON.parse(result.content[0]!.text);
}

test("validateDay accepts today and past dates, rejects the rest", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(validateDay(today), null);
  assert.equal(validateDay("2026-10-20"), null);
  assert.match(validateDay("2027-01-01")!, /Future puzzles are not available/);
  assert.match(validateDay("not-a-date")!, /YYYY-MM-DD/);
  assert.match(validateDay("2026-02-30")!, /not a real calendar date/);
  assert.match(validateDay("2026-10-1")!, /YYYY-MM-DD/);
});

test("chessvox_daily_puzzle returns today's puzzle as structured JSON", async () => {
  const { client, urls } = clientWith(200, DAILY);
  const tool = createTools(client).find((t) => t.name === "chessvox_daily_puzzle")!;

  const result = await tool.handler({});
  const payload = text(result) as { fen: string; solutionUci: string[]; rating: number };

  assert.equal(result.isError, undefined);
  assert.equal(urls[0], "https://chessvox.com/api/daily-puzzle");
  assert.equal(payload.fen, DAILY.puzzle.fen);
  assert.deepEqual(payload.solutionUci, ["c2h7"]);
  assert.equal(payload.rating, 666);
});

test("chessvox_daily_puzzle forwards a valid past day", async () => {
  const { client, urls } = clientWith(200, { ...DAILY, dayUtc: "2026-10-20" });
  const tool = createTools(client).find((t) => t.name === "chessvox_daily_puzzle")!;

  await tool.handler({ day: "2026-10-20" });

  assert.equal(urls[0], "https://chessvox.com/api/daily-puzzle?day=2026-10-20");
});

test("chessvox_daily_puzzle rejects malformed, impossible, and future days", async () => {
  const { client } = clientWith(200, DAILY);
  const tool = createTools(client).find((t) => t.name === "chessvox_daily_puzzle")!;

  for (const day of ["10/20/2026", "2026-02-30", "2099-01-01"]) {
    const result = await tool.handler({ day });
    assert.equal(result.isError, true, `expected error for ${day}`);
    assert.match(result.content[0]!.text, /Invalid day/);
  }
});

test("chessvox_mate_rush_puzzles returns the parsed batch", async () => {
  const body = {
    puzzles: [{ id: "p1", fen: "6k1/1pq4p w - - 2 40", moves: ["f6f8"] }],
  };
  const { client } = clientWith(200, body);
  const tool = createTools(client).find((t) => t.name === "chessvox_mate_rush_puzzles")!;

  const result = await tool.handler({});
  const payload = text(result) as { count: number; puzzles: { solutionUci: string[] }[] };

  assert.equal(payload.count, 1);
  assert.deepEqual(payload.puzzles[0]!.solutionUci, ["f6f8"]);
});

test("chessvox_starter_repertoires returns the parsed catalog", async () => {
  const body = {
    starters: [
      {
        slug: "caro-kann",
        name: "Caro-Kann",
        color: "black",
        description: "Solid.",
        styles: ["Solid"],
        lineCount: 6,
        previewMoves: ["e2e4", "c7c6"],
      },
    ],
  };
  const { client } = clientWith(200, body);
  const tool = createTools(client).find((t) => t.name === "chessvox_starter_repertoires")!;

  const result = await tool.handler({});
  const payload = text(result) as { count: number; starters: { slug: string }[] };

  assert.equal(payload.count, 1);
  assert.equal(payload.starters[0]!.slug, "caro-kann");
});

test("API errors degrade into isError content with a clear message", async () => {
  const { client } = clientWith(429, {});
  const tool = createTools(client).find((t) => t.name === "chessvox_daily_puzzle")!;

  const result = await tool.handler({});

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /rate limit/);
});

test("every tool has a chessvox_ name, description, and schema", () => {
  const { client } = clientWith(200, DAILY);
  const tools = createTools(client);

  assert.equal(tools.length, 3);
  for (const tool of tools) {
    assert.match(tool.name, /^chessvox_/);
    assert.ok(tool.description.length > 40, `${tool.name} needs a helpful description`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
  }
});
