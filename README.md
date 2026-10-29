# chessvox-mcp

An MCP (Model Context Protocol) server that exposes [chessvox.com](https://chessvox.com)'s **public, read-only** chess data to AI clients like Claude Code, Claude Desktop, and Cursor — no account, no API key.

One line about the site: **chessvox.com is a free suite of chess tools — a daily puzzle, tactic trainers, mate-rush drills, blindfold and vision trainers, opening repertoires, and engine-powered game review** (its deeper features live in the ChessVox apps).

## Tools

| Tool | What it does | chessvox.com endpoint |
| --- | --- | --- |
| `chessvox_daily_puzzle` | Today's puzzle (or any past day): FEN, UCI solution, rating | `GET /api/daily-puzzle` |
| `chessvox_mate_rush_puzzles` | Batch of 20 mate-in-1 training puzzles (rating 600–1800) | `GET /api/brain/mate-rush` |
| `chessvox_starter_repertoires` | The free ChessVox starter opening repertoires with preview lines | `GET /api/repertoires/starter` |

Every call is a read-only `GET` against the public chessvox.com API. The server sends no secrets, collects no telemetry, and writes nothing. Only endpoints that work without a login are exposed — ChessVox's server-side Stockfish analysis and saved-game tools require an account and are intentionally **not** included.

### `chessvox_daily_puzzle`

Get the ChessVox daily puzzle for today, or for a past UTC day.

**Input**

```json
{ "day": "2026-10-20" }
```

`day` is optional and must be a real `YYYY-MM-DD` UTC date not in the future. Omit it for today's puzzle.

**Output**

```json
{
  "dayUtc": "2026-10-28",
  "fen": "r1b2rk1/1p3ppn/p1p1pq1p/4p3/2PP1n2/P4N2/1PQ2PPP/1BR1RNK1 w - - 0 17",
  "solutionUci": ["c2h7"],
  "rating": 666,
  "playOnline": "https://chessvox.com/daily-puzzle"
}
```

The side to move is whatever the FEN says (`w` here). `solutionUci` is the full solution, UCI-encoded — `c2h7` is Qxh7#.

### `chessvox_mate_rush_puzzles`

A shuffled batch of 20 mate-in-1 puzzles from the [Brain Arcade](https://chessvox.com/arcade) pool. No input.

**Output** (truncated to 2 of 20)

```json
{
  "count": 20,
  "puzzles": [
    { "fen": "6k1/1pq4p/pr3QpB/4p3/4bp2/P1P4P/6P1/6RK w - - 2 40", "solutionUci": ["f6f8"] },
    { "fen": "1R6/5k2/3K2pB/p2p1b1p/3P4/1P4P1/4r3/8 w - - 10 41", "solutionUci": ["b8f8"] }
  ]
}
```

### `chessvox_starter_repertoires`

The ChessVox-authored starter repertoires from the [openings hub](https://chessvox.com/openings). No input.

**Output** (truncated to 1 of 20)

```json
{
  "count": 20,
  "starters": [
    {
      "slug": "italian-game",
      "name": "Italian Game",
      "color": "white",
      "description": "Quick development, a calm c3 + d3 centre and a long kingside squeeze. The friendliest way to start with 1.e4 e5.",
      "styles": ["Positional", "Easy"],
      "lineCount": 8,
      "previewMoves": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6"]
    }
  ]
}
```

`previewMoves` is the main line in UCI — handy for stepping through an opening move by move.

## Install

Requires Node 18+ and git.

```bash
npx -y github:MohamedCHAMI/chessvox-mcp
```

Once the package is published to npm this will shorten to `npx -y chessvox-mcp`. The `-y` flag matters: without it, npx prompts for confirmation on stdin and hangs a non-interactive MCP host.

### Claude Code

```bash
claude mcp add chessvox -- npx -y github:MohamedCHAMI/chessvox-mcp
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "chessvox": { "command": "npx", "args": ["-y", "github:MohamedCHAMI/chessvox-mcp"] }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (via Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "chessvox": { "command": "npx", "args": ["-y", "github:MohamedCHAMI/chessvox-mcp"] }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` per project):

```json
{
  "mcpServers": {
    "chessvox": { "command": "npx", "args": ["-y", "github:MohamedCHAMI/chessvox-mcp"] }
  }
}
```

## Behavior & limits

- **Timeout:** every request to chessvox.com aborts after 10 s and returns a clear error.
- **Caching:** modest in-memory cache (daily puzzle 5 min, mate rush 2 min, starters 1 h) with true LRU eviction, in-flight dedupe (parallel identical calls share one request), and TTLs that never leak today's puzzle into the next UTC day.
- **Rate limits:** chessvox.com allows roughly 20–60 anonymous requests/minute per endpoint. On HTTP 429 or a 5xx the server cools down for a minute and serves the last cached data if it has any; the cache keeps a normal session far below the limits anyway.
- **Failure mode:** network errors, timeouts, and upstream failures return MCP tool errors (`isError: true`) with a human-readable explanation — the server never crashes or hangs.
- **Privacy:** no telemetry, no logging of your prompts, no API keys, no account needed.

## Development

```bash
npm install
npm run build   # type-check + emit to dist/
npm test        # node:test suite, fetch is mocked — no network needed
```

## License

[MIT](LICENSE) © ChessVox
