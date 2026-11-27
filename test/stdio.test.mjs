// End-to-end smoke test: spawn the real server over stdio, run the MCP
// handshake, list tools, and call the offline tools. The best_move call uses
// depth 4 on the start position (seconds with the lite build) and skips when
// the stockfish dependency is missing.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enginePath } from "../src/engine.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
let nextId = 0;

function client() {
  const p = spawn(process.execPath, [CLI], { stdio: ["pipe", "pipe", "pipe"] });
  p.stderr.on("data", () => {}); // engine chatter stays out of the JSON-RPC stream
  const waiters = [];
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      for (let i = 0; i < waiters.length; ) {
        const w = waiters[i];
        if (w.match(msg)) { waiters.splice(i, 1); w.resolve(msg); } else i++;
      }
    }
  });
  const rpc = (method, params, match = (m) => m.id !== undefined) => {
    const id = ++nextId;
    return new Promise((resolve) => {
      waiters.push({ match: (m) => m.id === id && match(m), resolve });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return { p, rpc, done: () => once(p, "exit") };
}

test("MCP handshake, tools/list and offline tool calls", { timeout: 120_000 }, async () => {
  const c = client();
  const init = await c.rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  );
  assert.equal(init.result.serverInfo.name, "chessvox-mcp");
  c.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await c.rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["best_move", "daily_puzzle", "elo_change", "opening_info"]);

  const elo = await c.rpc("tools/call", {
    name: "elo_change",
    arguments: { rating: 1500, opponent: 1500, system: "fide" },
  });
  assert.match(elo.result.content[0].text, /win: \+10\.0/);
  assert.match(elo.result.content[0].text, /chessvox\.com/);

  const open = await c.rpc("tools/call", { name: "opening_info", arguments: { query: "London" } });
  assert.match(open.result.content[0].text, /London/);

  const bad = await c.rpc("tools/call", { name: "best_move", arguments: { fen: "not a fen" } });
  assert.match(bad.result.content[0].text, /Invalid FEN/);

  c.p.kill();
  await c.done();
});

test("best_move evaluates the start position over stdio", { timeout: 300_000, skip: !enginePath() && "stockfish dependency not installed" }, async () => {
  const c = client();
  await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  c.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const r = await c.rpc("tools/call", {
    name: "best_move",
    arguments: { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", depth: 4 },
  });
  const text = r.result.content[0].text;
  assert.match(text, /Best move: [a-hKQ]\w*/);
  assert.match(text, /Evaluation:/);
  assert.match(text, /chessvox\.com/);

  c.p.kill();
  await c.done();
});
