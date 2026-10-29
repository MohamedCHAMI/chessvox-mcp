import assert from "node:assert/strict";
import test from "node:test";

import { ChessVoxApiError, ChessVoxClient, type FetchLike } from "../src/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DAILY_PUZZLE_BODY = {
  dayUtc: "2026-10-28",
  puzzle: { id: "a94c87e4", fen: "6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", moves: ["d1d8"], rating: 666 },
  completed: false,
  completedAt: null,
};

/** Records every call and replies with a fixed response. */
function recordingFetch(status = 200, body: unknown = DAILY_PUZZLE_BODY) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(body, status);
  };
  return { calls, impl };
}

test("getDailyPuzzle requests the public endpoint with browser UA", async () => {
  const { calls, impl } = recordingFetch();
  const client = new ChessVoxClient({ fetchImpl: impl });

  const daily = await client.getDailyPuzzle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://chessvox.com/api/daily-puzzle");
  assert.equal(calls[0]!.init.method, "GET");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.match(headers["User-Agent"] ?? "", /Mozilla\/5\.0/);
  assert.equal(daily.puzzle.moves[0], "d1d8");
  assert.equal(daily.puzzle.rating, 666);
});

test("getDailyPuzzle passes an encoded day query parameter", async () => {
  const { calls, impl } = recordingFetch();
  const client = new ChessVoxClient({ fetchImpl: impl });

  await client.getDailyPuzzle("2026-10-20");

  assert.equal(calls[0]!.url, "https://chessvox.com/api/daily-puzzle?day=2026-10-20");
});

test("repeated calls are served from the in-memory cache", async () => {
  const { calls, impl } = recordingFetch();
  const client = new ChessVoxClient({ fetchImpl: impl });

  await client.getDailyPuzzle();
  await client.getDailyPuzzle();
  const again = await client.getDailyPuzzle();

  assert.equal(calls.length, 1, "fetch must be called exactly once");
  assert.equal(again.dayUtc, "2026-10-28");
});

test("different days use different cache entries", async () => {
  const { calls, impl } = recordingFetch(200, { ...DAILY_PUZZLE_BODY, dayUtc: "2026-10-20" });
  const client = new ChessVoxClient({ fetchImpl: impl });

  await client.getDailyPuzzle("2026-10-20");
  await client.getDailyPuzzle("2026-10-20");
  await client.getDailyPuzzle("2026-10-21");

  assert.equal(calls.length, 2);
});

test("HTTP 429 surfaces a friendly rate-limit error", async () => {
  const client = new ChessVoxClient({
    fetchImpl: async () => jsonResponse({ error: "Too many requests" }, 429),
  });

  await assert.rejects(
    () => client.getDailyPuzzle(),
    (error: unknown) =>
      error instanceof ChessVoxApiError &&
      error.status === 429 &&
      error.message.includes("rate limit")
  );
});

test("HTTP 403 surfaces an edge-protection hint, not an auth demand", async () => {
  const client = new ChessVoxClient({
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
  });

  await assert.rejects(
    () => client.getDailyPuzzle(),
    (error: unknown) =>
      error instanceof ChessVoxApiError && error.message.includes("public") && error.message.includes("403")
  );
});

test("server errors surface as retryable ChessVoxApiError", async () => {
  const client = new ChessVoxClient({
    fetchImpl: async () => jsonResponse({ error: "boom" }, 503),
  });

  await assert.rejects(
    () => client.getMateRushPuzzles(),
    (error: unknown) => error instanceof ChessVoxApiError && error.status === 503
  );
});

test("request timeouts produce a clear timeout message", async () => {
  const client = new ChessVoxClient({
    timeoutMs: 5,
    fetchImpl: async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    },
  });

  await assert.rejects(
    () => client.getStarterRepertoires(),
    (error: unknown) =>
      error instanceof ChessVoxApiError && error.message.includes("did not respond within")
  );
});

test("network failures produce a reachable-host message", async () => {
  const client = new ChessVoxClient({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND chessvox.com");
    },
  });

  await assert.rejects(
    () => client.getDailyPuzzle(),
    (error: unknown) =>
      error instanceof ChessVoxApiError && error.message.includes("Could not reach chessvox.com")
  );
});

test("non-JSON responses produce a clear parse error", async () => {
  const client = new ChessVoxClient({
    fetchImpl: async () => new Response("<html>maintenance</html>", { status: 200 }),
  });

  await assert.rejects(
    () => client.getDailyPuzzle(),
    (error: unknown) => error instanceof ChessVoxApiError && error.message.includes("not valid JSON")
  );
});

test("unexpected response shapes produce a contract error", async () => {
  const client = new ChessVoxClient({
    fetchImpl: async () => jsonResponse({ ok: true }),
  });

  await assert.rejects(
    () => client.getDailyPuzzle(),
    (error: unknown) =>
      error instanceof ChessVoxApiError &&
      error.message.includes("Unexpected response structure from chessvox.com")
  );
});

test("getMateRushPuzzles parses the puzzle batch shape", async () => {
  const body = {
    puzzles: [
      { id: "p1", fen: "6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 2 40", moves: ["d1d8"] },
      { id: "p2", fen: "1R6/5k2/8/8/8/8/8/6K1 w - - 10 41", moves: ["b8f8"] },
    ],
  };
  const client = new ChessVoxClient({ fetchImpl: async () => jsonResponse(body) });

  const batch = await client.getMateRushPuzzles();

  // The batch is shuffled per call, so assert membership rather than order.
  assert.equal(batch.puzzles.length, 2);
  const fens = batch.puzzles.map((p) => p.fen).sort();
  assert.deepEqual(fens, [
    "1R6/5k2/8/8/8/8/8/6K1 w - - 10 41",
    "6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 2 40",
  ]);
});

test("getStarterRepertoires parses the starters shape", async () => {
  const body = {
    starters: [
      {
        slug: "italian-game",
        name: "Italian Game",
        color: "white",
        description: "Quick development.",
        styles: ["Positional", "Easy"],
        lineCount: 8,
        previewMoves: ["e2e4", "e7e5"],
      },
    ],
  };
  const client = new ChessVoxClient({ fetchImpl: async () => jsonResponse(body) });

  const { starters } = await client.getStarterRepertoires();

  assert.equal(starters[0]!.slug, "italian-game");
  assert.equal(starters[0]!.color, "white");
});

test("a 429 sets a cooldown: the next call fails fast without another request", async () => {
  let calls = 0;
  const impl: FetchLike = async () => {
    calls += 1;
    return jsonResponse({ error: "Too many requests" }, 429);
  };
  const client = new ChessVoxClient({ fetchImpl: impl });

  await assert.rejects(() => client.getDailyPuzzle(), /rate limit/);
  await assert.rejects(() => client.getDailyPuzzle(), /Cooling down/);
  assert.equal(calls, 1, "cooldown must not hit the network again");
});

test("parallel identical calls share one in-flight request", async () => {
  // Gate the single upstream request so both callers must join it
  // deterministically — no timers involved.
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const impl: FetchLike = async () => {
    calls += 1;
    await gate.promise;
    return jsonResponse(DAILY_PUZZLE_BODY);
  };
  const client = new ChessVoxClient({ fetchImpl: impl });

  const first = client.getDailyPuzzle();
  const second = client.getDailyPuzzle();
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1, "both callers must share one request");
  assert.equal(a.dayUtc, b.dayUtc);
});
