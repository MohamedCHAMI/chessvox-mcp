import { z } from "zod";

import { ChessVoxApiError, ChessVoxClient } from "./client.js";

/**
 * Tool definitions: one tool per verified public chessvox.com endpoint.
 * Structured as data so tests can exercise handlers directly with a
 * mocked fetch, and index.ts only wires them into the MCP server.
 */

export interface ToolHandlerResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
}

function ok(value: unknown): ToolHandlerResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}


/** Runs a handler, translating client errors into MCP error content. */
async function guard(run: () => Promise<ToolHandlerResult>): Promise<ToolHandlerResult> {
  try {
    return await run();
  } catch (error) {
    const message =
      error instanceof ChessVoxApiError
        ? error.message
        : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a `YYYY-MM-DD` string that is a real, non-future UTC date. */
export function validateDay(day: string): string | null {
  if (!DAY_PATTERN.test(day)) {
    return `day must be a UTC date in YYYY-MM-DD format (got "${day}").`;
  }
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return `day "${day}" is not a real calendar date.`;
  }
  const today = new Date();
  const todayUtc = today.toISOString().slice(0, 10);
  if (day > todayUtc) {
    return `Future puzzles are not available: day "${day}" is after today (${todayUtc}).`;
  }
  return null;
}

export function createTools(client: ChessVoxClient): ToolDefinition[] {
  const dailyPuzzle: ToolDefinition = {
    name: "chessvox_daily_puzzle",
    title: "ChessVox daily puzzle",
    description:
      "Get the ChessVox daily puzzle (https://chessvox.com/daily-puzzle) for today, or for a past UTC day via the optional `day` argument. " +
      "Returns the puzzle FEN, the full solution as UCI moves (e.g. [\"c2h7\"] for Qxh7#), and its player rating. " +
      "The side to move is given by the FEN. Useful for showing a puzzle, hinting the first solution move, or verifying a user's answer.",
    inputSchema: {
      day: z
        .string()
        .regex(DAY_PATTERN, "day must be a UTC date in YYYY-MM-DD format")
        .optional()
        .describe("Optional past UTC day to fetch instead of today's puzzle, e.g. 2026-10-20"),
    },
    handler: async (args) =>
      guard(async () => {
        const day = typeof args.day === "string" ? args.day : undefined;
        if (day) {
          const error = validateDay(day);
          if (error) {
            return { content: [{ type: "text", text: `Invalid day: ${error}` }], isError: true };
          }
        }
        const puzzle = await client.getDailyPuzzle(day);
        return ok({
          dayUtc: puzzle.dayUtc,
          fen: puzzle.puzzle.fen,
          solutionUci: puzzle.puzzle.moves,
          rating: puzzle.puzzle.rating,
          playOnline: `https://chessvox.com/daily-puzzle`,
        });
      }),
  };

  const mateRush: ToolDefinition = {
    name: "chessvox_mate_rush_puzzles",
    title: "ChessVox mate-in-1 puzzles",
    description:
      "Get a batch of 20 mate-in-1 training puzzles from the ChessVox Brain Arcade pool (https://chessvox.com/arcade), player ratings 600–1800. " +
      "Each puzzle has a FEN and its winning move in UCI. Ideal for quick tactic drills or generating practice positions.",
    inputSchema: {},
    handler: async () =>
      guard(async () => {
        const { puzzles } = await client.getMateRushPuzzles();
        return ok({
          count: puzzles.length,
          puzzles: puzzles.map((p) => ({ fen: p.fen, solutionUci: p.moves })),
        });
      }),
  };

  const starters: ToolDefinition = {
    name: "chessvox_starter_repertoires",
    title: "ChessVox starter repertoires",
    description:
      "List the free ChessVox-authored starter opening repertoires (https://chessvox.com/openings), e.g. the Italian Game or the Caro-Kann. " +
      "Each entry has the color, a plain-language description, style tags, the number of lines, and the UCI preview moves of the main line. " +
      "Use it to recommend a first repertoire or to show what a specific opening looks like move by move.",
    inputSchema: {},
    handler: async () =>
      guard(async () => {
        const { starters: list } = await client.getStarterRepertoires();
        return ok({ count: list.length, starters: list });
      }),
  };

  return [dailyPuzzle, mateRush, starters];
}
