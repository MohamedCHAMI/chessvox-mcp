/**
 * HTTP client for the public, read-only chessvox.com API endpoints.
 *
 * - No authentication, no API keys, no writes: every call is a plain GET.
 * - Every request carries a browser-like User-Agent: the site's edge
 *   protection rejects requests with library/empty User-Agents.
 * - Each request has a timeout and a small in-memory TTL cache so MCP
 *   clients that re-ask the same question stay well inside the public
 *   rate limits (daily puzzle: 30/min anonymous, mate rush: 20/min and
 *   60/hour, starters: served cacheable).
 */

const DEFAULT_BASE_URL = "https://chessvox.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 128;

/** TTLs chosen to respect the server's public rate limits. */
const CACHE_TTL_MS = {
  dailyPuzzle: 5 * 60_000,
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

export interface DailyPuzzle {
  dayUtc: string;
  puzzle: {
    id: string;
    fen: string;
    /** Solution moves in UCI, e.g. ["c2h7"]. */
    moves: string[];
    rating: number;
  };
  completed: boolean;
  completedAt: string | null;
}

export interface MateRushPuzzle {
  id: string;
  fen: string;
  /** Solution move(s) in UCI; mate-rush puzzles are mate-in-1. */
  moves: string[];
}

export interface StarterRepertoire {
  slug: string;
  name: string;
  color: "white" | "black";
  description: string;
  styles: string[];
  lineCount: number;
  /** First moves of the main line, in UCI. */
  previewMoves: string[];
}

export interface ChessVoxClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

export class ChessVoxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ChessVoxClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Today's puzzle, or the puzzle for a past UTC day (`YYYY-MM-DD`). */
  async getDailyPuzzle(day?: string): Promise<DailyPuzzle> {
    const query = day ? `?day=${encodeURIComponent(day)}` : "";
    return this.request(`/api/daily-puzzle${query}`, CACHE_TTL_MS.dailyPuzzle) as Promise<DailyPuzzle>;
  }

  /** A shuffled batch of mate-in-1 puzzles (FEN + UCI solution). */
  async getMateRushPuzzles(): Promise<{ puzzles: MateRushPuzzle[] }> {
    return this.request("/api/brain/mate-rush", CACHE_TTL_MS.mateRush) as Promise<{
      puzzles: MateRushPuzzle[];
    }>;
  }

  /** ChessVox-authored starter opening repertoires. */
  async getStarterRepertoires(): Promise<{ starters: StarterRepertoire[] }> {
    return this.request("/api/repertoires/starter", CACHE_TTL_MS.starters) as Promise<{
      starters: StarterRepertoire[];
    }>;
  }

  private async request(path: string, ttlMs: number): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ChessVoxApiError(
          `chessvox.com did not respond within ${this.timeoutMs / 1000}s. Please retry in a moment.`
        );
      }
      throw new ChessVoxApiError(
        `Could not reach chessvox.com: ${error instanceof Error ? error.message : String(error)}. Check your network connection and retry.`
      );
    }

    if (response.status === 403 || response.status === 401) {
      throw new ChessVoxApiError(
        "chessvox.com refused the request (HTTP " +
          response.status +
          "). The endpoint is public, so this usually means temporary edge protection — wait a bit and retry.",
        response.status
      );
    }
    if (response.status === 429) {
      throw new ChessVoxApiError(
        "chessvox.com rate limit reached (HTTP 429). Public endpoints allow roughly 20–60 requests per minute; wait about a minute and retry.",
        response.status
      );
    }
    if (!response.ok) {
      throw new ChessVoxApiError(
        `chessvox.com returned HTTP ${response.status}. The service may be briefly unavailable; retry shortly.`,
        response.status
      );
    }

    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ChessVoxApiError(
        "chessvox.com returned a response that is not valid JSON. Retry in a moment."
      );
    }

    // Evict oldest entries if the cache grows beyond a modest bound.
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(path, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }
}
