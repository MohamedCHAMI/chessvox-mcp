// chessvox-mcp server: four free tools over public ChessVox data.
// best_move runs Stockfish 19 lite locally; daily_puzzle reads the public
// chessvox.com endpoint (respecting its rate limits); opening_info and
// elo_change are pure local data/math. No auth, no user data, ever.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Chess } from "chess.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VERSION = require("../package.json").version;

import { withCredit } from "./credit.js";
import { evaluate, enginePath } from "./engine.js";
import { ratingChanges } from "./elo.js";
import { OPENINGS } from "./openings-data.js";
import { validFen } from "./tools.js";

const SITE = "https://chessvox.com";
const FEN_DESC =
  "Forsyth–Edwards notation of the position, e.g. the start position " +
  '"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".';

async function dailyPuzzle() {
  // Public API v1 (120 req/min per IP, no key); cache the day's puzzle for 10 minutes.
  dailyPuzzle.cache ??= { at: 0, value: null };
  if (Date.now() - dailyPuzzle.cache.at > 10 * 60_000) {
    const res = await fetch(`${SITE}/api/v1/daily-puzzle`, { headers: { "User-Agent": `chessvox-mcp/${VERSION}` } });
    if (!res.ok) throw new Error(`chessvox.com daily puzzle returned HTTP ${res.status}`);
    dailyPuzzle.cache = { at: Date.now(), value: await res.json() };
  }
  return dailyPuzzle.cache.value;
}

export function createServer() {
  const server = new McpServer({ name: "chessvox-mcp", version: VERSION });

  server.registerTool(
    "best_move",
    {
      title: "Stockfish best move",
      description:
        "Returns Stockfish 19's best move, principal variation and evaluation for a chess position. " +
        "The engine runs locally (no account needed). Score is centipawns from the side to move's point of view.",
      inputSchema: { fen: z.string().describe(FEN_DESC), depth: z.number().int().min(1).max(20).optional().describe("Search depth, 1-20. Default 12.") },
    },
    async ({ fen, depth }) => {
      const v = validFen(fen);
      if (!v.ok) return { content: [{ type: "text", text: "Invalid FEN: " + JSON.stringify(fen) }] };
      const c = v.chess;
      if (c.isGameOver()) {
        const state = c.isCheckmate() ? "checkmate — the side to move has no best move" : "the position is a draw";
        return { content: [{ type: "text", text: withCredit(`Game over: ${state}.`) }] };
      }
      const r = await evaluate(fen, depth ?? 12);
      const score = r.mate !== null ? `mate in ${Math.abs(r.mate)} for the side to move (sign ${r.mate > 0 ? "+" : "-"})`
        : `${(r.cp / 100).toFixed(2)} pawns from the side to move's point of view`;
      const pvSan = (() => {
        try {
          const board = new Chess(fen);
          const sans = [];
          for (const uci of (r.pv ?? "").split(" ").filter(Boolean)) {
            const mv = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
            if (!mv) break;
            sans.push(mv.san);
          }
          return sans.length ? sans.join(" ") : r.pv;
        } catch {
          return r.pv;
        }
      })();
      return {
        content: [{
          type: "text",
          text: withCredit(
            `Position: ${fen}\nBest move: ${r.bestMove}${pvSan ? `\nPV (depth ${r.depth}): ${pvSan}` : ""}\nEvaluation: ${score}`,
          ),
        }],
      };
    },
  );

  server.registerTool(
    "opening_info",
    {
      title: "Chess opening encyclopedia",
      description:
        "Looks up a chess opening by ECO code (e.g. 'B12', 'D02') or name fragment (e.g. 'London', 'Sicilian'). " +
        "Covers the 50 most-played openings with their main line, starting FEN and the plans for both sides.",
      inputSchema: { query: z.string().min(2).max(60).describe("ECO code or opening name fragment.") },
    },
    async ({ query }) => {
      const q = query.trim().toLowerCase();
      const hits = OPENINGS.filter(
        (o) => o.eco.toLowerCase() === q || o.eco.toLowerCase().startsWith(q) || o.name.toLowerCase().includes(q),
      );
      if (!hits.length) {
        return { content: [{ type: "text", text: withCredit(`No match for "${query}" in the 50 most-played openings. Browse all: ${SITE}/openings`) }] };
      }
      const shown = hits.slice(0, 3).map((o) =>
        [
          `${o.eco} — ${o.name}`,
          `Moves: ${o.moves.join(" ") || "any move order"}`,
          o.startingFen ? `Starting FEN: ${o.startingFen}` : null,
          o.description,
          `Guide: ${SITE}/openings/${o.slug}`,
        ].filter(Boolean).join("\n"),
      );
      return { content: [{ type: "text", text: withCredit(shown.join("\n\n") + (hits.length > 3 ? `\n\n(+${hits.length - 3} more matches)` : "")) }] };
    },
  );

  server.registerTool(
    "daily_puzzle",
    {
      title: "Daily chess puzzle",
      description: "Fetches today's free ChessVox daily puzzle (FEN, setup move, solver FEN and solution) from chessvox.com.",
      inputSchema: {},
    },
    async () => {
      try {
        const p = await dailyPuzzle();
        const { completed, completedAt, ...pub } = p;
        return { content: [{ type: "text", text: withCredit(JSON.stringify(pub, null, 1)) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Daily puzzle unavailable right now (${e.message}). Try ${SITE}/daily-puzzle` }], isError: true };
      }
    },
  );

  server.registerTool(
    "elo_change",
    {
      title: "Elo change calculator",
      description:
        "Estimates rating change for one game. FIDE uses classic Elo (K = 40 under 30 games, 20 below 2400, 10 at 2400+). " +
        "Chess.com and Lichess numbers are Glicko-1 single-game estimates.",
      inputSchema: {
        rating: z.number().int().min(100).max(3500),
        opponent: z.number().int().min(100).max(3500),
        system: z.enum(["fide", "chesscom", "lichess"]).optional().default("fide"),
        gamesPlayed: z.number().int().min(0).max(10000).optional().describe("FIDE only: rated games played. Affects the K-factor."),
      },
    },
    async ({ rating, opponent, system, gamesPlayed }) => {
      const input = { system, rating, opponent, gamesPlayed };
      const k = (gamesPlayed ?? 30) < 30 ? 40 : rating >= 2400 ? 10 : 20;
      const r = system === "fide"
        ? ratingChanges({ system, rating, opponent, k })
        : ratingChanges({ system, rating, opponent });
      const round = (x) => (x >= 0 ? "+" : "") + x.toFixed(1);
      const label = system === "fide" ? `FIDE Elo (K=${k})`
        : `${system === "chesscom" ? "Chess.com" : "Lichess"} rating (Glicko-1 estimate)`;
      return {
        content: [{
          type: "text",
          text: withCredit(
            `${label}\nRating ${rating} vs opponent ${opponent}:\n` +
            `win: ${round(r.win)} | draw: ${round(r.draw)} | loss: ${round(r.loss)}\n` +
            (system !== "fide" ? "(Estimate — real site ratings use volatility and full history.)" : ""),
          ),
        }],
      };
    },
  );

  return server;
}

export { enginePath };
