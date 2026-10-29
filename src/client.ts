import { z } from "zod";

/**
 * HTTP client for the public, read-only chessvox.com API endpoints.
 *
 * - No authentication, no API keys, no writes: every call is a plain GET.
 * - Every request carries a browser-like User-Agent: the site's edge
 *   protection rejects requests with library/empty User-Agents.
 * - Each request has a timeout and a small in-memory cache (TTL + LRU,
 *   in-flight dedupe, stale-if-error on rate limits) so MCP clients
 *   that re-ask the same question stay well inside the public rate
 *   limits (daily puzzle: 30/min anonymous, mate rush: 20/min and
 *   60/hour, starters: served cacheable).
 * - Responses are parsed once at this boundary with zod, so an upstream
 *   contract change surfaces as a clear error instead of a TypeError.
 */

const DEFAULT_BASE_URL = "https://chessvox.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 128;
/** Back-off window after a rate limit: public endpoints allow ~20–60/min. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/** TTLs chosen to respect the server's public rate limits. */
const CACHE_TTL_MS = {
  dailyPuzzle: 5 * 60_000,
  dailyPuzzlePast: 24 * 60 * 60_000,
  mateRush: 2 * 60_000,
  starters: 60 * 60_000,
} as const;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 ChessVoxMCP/1.0";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ChessVoxApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ChessVoxApiError";
    this.status = status;
  }
}

const UciMoves = z.array(z.string());

export const DailyPuzzleSchema = z.object({
  dayUtc: z.string(),
  puzzle: z.object({
    id: z.string(),
    fen: z.string(),
    moves: UciMoves,
    rating: z.number(),
  }),
  completed: z.boolean(),
  completedAt: z.string().nullable(),
});
export type DailyPuzzle = z.infer<typeof DailyPuzzleSchema>;

export const MateRushSchema = z.object({
  puzzles: z.array(
    z.object({
      id: z.string(),
      fen: z.string(),
      moves: UciMoves,
    })
  ),
});
export type MateRushPuzzle = z.infer<typeof MateRushSchema>["puzzles"][number];

export const StarterRepertoiresSchema = z.object({
  starters: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      color: z.string(),
      description: z.string(),
      styles: z.array(z.string()),
      lineCount: z.number(),
      previewMoves: UciMoves,
    })
  ),
});
export type StarterRepertoire = z.infer<typeof StarterRepertoiresSchema>["starters"][number];

export interface ChessVoxClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/** Parses at the boundary; upstream contract changes become clear errors. */
function parseAt<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ChessVoxApiError(
      `Unexpected response structure from chessvox.com (${what}). Retry in a moment.`
    );
  }
  return parsed.data;
}

/** Fisher–Yates shuffle of a copy, so every mate-rush call feels fresh. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export class ChessVoxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private cooldownUntil = 0;

  constructor(options: ChessVoxClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Today's puzzle, or the puzzle for a past UTC day (`YYYY-MM-DD`). */
  async getDailyPuzzle(day?: string, signal?: AbortSignal): Promise<DailyPuzzle> {
    const now = new Date();
    const todayUtc = now.toISOString().slice(0, 10);
    const query = day ? `?day=${encodeURIComponent(day)}` : "";
    // Canonical cache key: one entry per calendar day, never a stale
    // "today" served after UTC midnight.
    const cacheKey = `/api/daily-puzzle?day=${day ?? todayUtc}`;
    const ttl =
      day && day !== todayUtc
        ? CACHE_TTL_MS.dailyPuzzlePast // past days are immutable
        : Math.max(1_000, Math.min(CACHE_TTL_MS.dailyPuzzle, msUntilUtcMidnight(now)));
    const value = await this.request(`/api/daily-puzzle${query}`, ttl, { cacheKey, signal });
    return parseAt(DailyPuzzleSchema, value, "daily puzzle");
  }

  /** A shuffled batch of mate-in-1 puzzles (FEN + UCI solution). */
  async getMateRushPuzzles(signal?: AbortSignal): Promise<{ puzzles: MateRushPuzzle[] }> {
    const value = await this.request("/api/brain/mate-rush", CACHE_TTL_MS.mateRush, { signal });
    return { puzzles: shuffled(parseAt(MateRushSchema, value, "mate rush").puzzles) };
  }

  /** ChessVox-authored starter opening repertoires. */
  async getStarterRepertoires(signal?: AbortSignal): Promise<{ starters: StarterRepertoire[] }> {
    const value = await this.request("/api/repertoires/starter", CACHE_TTL_MS.starters, { signal });
    return { starters: parseAt(StarterRepertoiresSchema, value, "starter repertoires").starters };
  }

  private async request(
    path: string,
    ttlMs: number,
    options: { cacheKey?: string; signal?: AbortSignal } = {}
  ): Promise<unknown> {
    const cacheKey = options.cacheKey ?? path;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Stampede guard: parallel calls for the same key share one request.
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    // During a rate-limit cooldown, serve stale data instead of hammering.
    if (Date.now() < this.cooldownUntil) {
      if (cached) return cached.value;
      throw new ChessVoxApiError(
        "Cooling down after a chessvox.com rate limit. Wait about a minute and retry."
      );
    }

    const task = this.fetchAndCache(path, cacheKey, ttlMs, options.signal).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, task);
    return task;
  }

  private async fetchAndCache(
    path: string,
    cacheKey: string,
    ttlMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const stale = this.cache.get(cacheKey)?.value;

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal =
      signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return this.staleOrThrow(
          stale,
          `chessvox.com did not respond within ${this.timeoutMs / 1000}s. Please retry in a moment.`
        );
      }
      if (error instanceof Error && error.name === "AbortError" && signal?.aborted) {
        throw new ChessVoxApiError("Request cancelled by the MCP client.");
      }
      return this.staleOrThrow(
        stale,
        `Could not reach chessvox.com: ${error instanceof Error ? error.message : String(error)}. Check your network connection and retry.`
      );
    }

    if (response.status === 403 || response.status === 401) {
      return this.staleOrThrow(
        stale,
        "chessvox.com refused the request (HTTP " +
          response.status +
          "). The endpoint is public, so this usually means temporary edge protection — wait a bit and retry.",
        response.status
      );
    }
    if (response.status === 429) {
      this.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      return this.staleOrThrow(
        stale,
        "chessvox.com rate limit reached (HTTP 429). Public endpoints allow roughly 20–60 requests per minute; wait about a minute and retry.",
        429
      );
    }
    if (!response.ok) {
      if (response.status >= 500) this.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      return this.staleOrThrow(
        stale,
        `chessvox.com returned HTTP ${response.status}${detail ? `: ${detail}` : "."} The service may be briefly unavailable; retry shortly.`,
        response.status
      );
    }

    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.staleOrThrow(
        stale,
        "chessvox.com returned a response that is not valid JSON. Retry in a moment."
      );
    }

    // True LRU: re-inserting a key refreshes its position; only a genuinely
    // new key evicts the oldest entry.
    if (!this.cache.has(cacheKey) && this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }

  /** Prefer slightly stale public data over failing a read-only tool call. */
  private staleOrThrow(stale: unknown | undefined, message: string, status?: number): unknown {
    if (stale !== undefined) return stale;
    throw new ChessVoxApiError(message, status);
  }
}

/** Milliseconds until the next UTC midnight. */
function msUntilUtcMidnight(now: Date): number {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  return Date.parse(`${tomorrow}T00:00:00Z`) - now.getTime();
}
