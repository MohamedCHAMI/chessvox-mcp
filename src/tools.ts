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

/** MCP tool annotations: hints about what each tool does. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Extra context the MCP client passes with each tool call. */
export interface ToolExtra {
  /** Aborts when the client cancels the request. */
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, extra?: ToolExtra) => Promise<ToolHandlerResult>;
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
  if (y < 2000) {
    return `day "${day}" is not a real puzzle date: the archive starts well after 2000.`;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC maps 2-digit years onto 1900–1999; the y < 2000 guard above
  // makes the round-trip check below sufficient.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return `day "${day}" is not a real calendar date.`;
  }
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (day > todayUtc) {
    return `Future puzzles are not available: day "${day}" is after the current UTC date (${todayUtc}).`;
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      day: z
        .string()
        .regex(DAY_PATTERN, "day must be a UTC date in YYYY-MM-DD format")
        .optional()
        .describe("Optional past UTC day to fetch instead of today's puzzle, e.g. 2026-10-20"),
      date: z
        .string()
        .regex(DAY_PATTERN, "date must be a UTC date in YYYY-MM-DD format")
        .optional()
        .describe("Alias for `day`; use whichever feels more natural"),
    },
    handler: async (args, extra) =>
      guard(async () => {
        const raw =
          typeof args.day === "string" ? args.day : typeof args.date === "string" ? args.date : undefined;
        let day: string | undefined;
        if (raw) {
          const error = validateDay(raw);
          if (error) {
            return { content: [{ type: "text", text: `Invalid day: ${error}` }], isError: true };
          }
          day = raw;
        }
        const puzzle = await client.getDailyPuzzle(day, extra?.signal);
        return ok({
          dayUtc: puzzle.dayUtc,
          fen: puzzle.puzzle.fen,
          solutionUci: puzzle.puzzle.moves,
          rating: puzzle.puzzle.rating,
          playOnline:
            day && day < new Date().toISOString().slice(0, 10)
              ? `https://chessvox.com/daily-puzzle?day=${encodeURIComponent(day)}`
              : `https://chessvox.com/daily-puzzle`,
        });
      }),
  };

  const mateRush: ToolDefinition = {
    name: "chessvox_mate_rush_puzzles",
    title: "ChessVox mate-in-1 puzzles",
    description:
      "Get a batch of 20 mate-in-1 training puzzles from the ChessVox Brain Arcade pool (https://chessvox.com/arcade), player ratings 600–1800. " +
      "Each puzzle has a FEN and its winning move in UCI, and every call returns the batch in a fresh order. " +
      "Ideal for quick tactic drills or generating practice positions.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {},
    handler: async (_args, extra) =>
      guard(async () => {
        const { puzzles } = await client.getMateRushPuzzles(extra?.signal);
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {},
    handler: async (_args, extra) =>
      guard(async () => {
        const { starters: list } = await client.getStarterRepertoires(extra?.signal);
        return ok({ count: list.length, starters: list });
      }),
  };

  return [dailyPuzzle, mateRush, starters];
}
