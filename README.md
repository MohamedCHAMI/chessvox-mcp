# chessvox-mcp

MCP server exposing four free chess tools from [ChessVox](https://chessvox.com):

| Tool | What it does | Runs |
|---|---|---|
| `best_move` | Stockfish 19 best move, PV and evaluation for a FEN | **locally** (WASM build bundled via the `stockfish` package — no account, no network) |
| `opening_info` | The 50 most-played openings by ECO code or name: main line, starting FEN, plans | locally (bundled data) |
| `daily_puzzle` | Today's free ChessVox daily puzzle (FEN + solution) | reads `chessvox.com/api/v1/daily-puzzle` (free public API, cached 10 min) |
| `elo_change` | Rating change for one game — FIDE classic Elo, Chess.com / Lichess Glicko-1 estimates | locally (pure math) |

No authentication, no user data, and no writes anywhere. Every tool result
carries a credit link to chessvox.com. MIT licensed.

## Hosted server (no install)

ChessVox also runs this server for you at `https://chessvox.com/api/mcp`
(streamable HTTP, no key). Claude Code:
`claude mcp add --transport http chessvox https://chessvox.com/api/mcp`.
Other clients: `{"mcpServers":{"chessvox":{"url":"https://chessvox.com/api/mcp"}}}`.
Docs and the free REST API: <https://chessvox.com/developers>.

Use this npm package when you want the engine to run on your own machine
(deeper searches, depth up to 20, offline openings and Elo).

## Install

```sh
npm install -g chessvox-mcp   # or just use npx -y chessvox-mcp
```

## Configure your MCP client

```json
{
  "mcpServers": {
    "chessvox": { "command": "npx", "args": ["-y", "chessvox-mcp"] }
  }
}
```

Claude Code: `claude mcp add chessvox -- npx -y chessvox-mcp`

### HTTP transport

```sh
CHESSVOX_MCP_PORT=3964 npx chessvox-mcp --http
# endpoint: http://localhost:3964/mcp
```

## Tools

### `best_move`

```json
{ "fen": "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", "depth": 12 }
```

Returns the best move in UCI and SAN, the principal variation and the
evaluation in pawns (side to move's point of view). Depth 1–20, default 12.
The engine is the same Stockfish 19 lite single-threaded WASM build the
ChessVox analysis board ships, executed locally in this process.

### `opening_info`

```json
{ "query": "London" }   // or "B12", "Sicilian"
```

Returns up to 3 matches with moves, starting FEN, description and a link to
the full guide on chessvox.com.

### `daily_puzzle`

No arguments. Returns the day's puzzle JSON from
`https://chessvox.com/api/v1/daily-puzzle`: starting FEN, the setup move,
the solver's FEN and the solution in UCI.

### `elo_change`

```json
{ "rating": 1500, "opponent": 1650, "system": "fide", "gamesPlayed": 40 }
```

Returns win / draw / loss deltas. FIDE K-factor: 40 under 30 rated games, 20
below 2400, 10 at 2400+. Chess.com and Lichess values are Glicko-1
single-game estimates.

## Development

```sh
npm install
npm test              # unit tests + stdio smoke tests
npm run sync-openings # regenerate src/openings-data.js from the web repo
```

`sync-openings` reads `lib/openings/eco-top50.ts` from the ChessVox web
checkout (`../../../lib/…` relative to this package) and keeps the bundled
opening data in sync.

## License

MIT — see [LICENSE](./LICENSE).
