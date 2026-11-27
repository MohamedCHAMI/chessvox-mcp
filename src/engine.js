// Minimal UCI wrapper around the Stockfish 19 lite WASM build — a faithful JS
// port of the ChessVox web app's lib/chess/stockfish-engine.ts, which is
// battle-tested in production. Key details it teaches:
// - Boot is signalled by the "Stockfish ..." banner; only THEN send `uci`.
// - One search at a time; `bestmove` ends it; guard with a timeout.
// The engine runs locally in this process — no network, no rate limits touched.
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function enginePath() {
  const rels = ["bin/stockfish-19-lite-single.js", "src/stockfish-19-lite-single.js"];
  // Resolve through Node's algorithm so hoisted/global/npx layouts work
  // (stockfish is NOT necessarily inside this package's own node_modules).
  try {
    const dir = path.dirname(require.resolve("stockfish/package.json"));
    for (const rel of rels) {
      if (existsSync(path.join(dir, rel))) return path.join(dir, rel);
    }
  } catch { /* exports map may block package.json; fall through to the walk */ }
  // Walk up from this file: package-local node_modules first, then every
  // hoisted ancestor (npm/npx/global layouts).
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++) {
    for (const rel of rels) {
      const candidate = path.join(dir, "node_modules", "stockfish", rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let proc = null;
let queue = Promise.resolve();
let listeners = [];
let pending = null; // { info: [], resolve, reject, timeout }
let outputBuffer = "";

function failPending(error) {
  if (pending) {
    clearTimeout(pending.timeout);
    const { reject } = pending;
    pending = null;
    reject(error);
  }
}

function handleLine(line) {
  if (!line) return;

  // Generic waiters (uciok / readyok / boot) first; a matched waiter removes itself.
  for (let i = listeners.length - 1; i >= 0; i--) {
    if (listeners[i](line)) listeners.splice(i, 1);
  }

  if (line.startsWith("info ") && pending) {
    if (line.includes(" score ") && line.includes(" pv ")) pending.info.push(line);
    return;
  }

  if (line.startsWith("bestmove") && pending) {
    const last = pending.info.at(-1) ?? "";
    const cp = last.match(/ score cp (-?\d+)/)?.[1];
    const mate = last.match(/ score mate (-?\d+)/)?.[1];
    const result = {
      bestMove: line.split(/\s+/)[1] ?? null,
      pv: last.match(/ pv (.+)$/)?.[1] ?? null,
      /** Centipawn score, side to move. Null when the position is a forced mate. */
      cp: cp === undefined ? null : Number(cp),
      /** Mate distance in moves, side to move. Null unless a mate was found. */
      mate: mate === undefined ? null : Number(mate),
      depth: Number(last.match(/ depth (\d+)/)?.[1] ?? 0),
    };
    clearTimeout(pending.timeout);
    const { resolve } = pending;
    pending = null;
    resolve(result);
  }
}

function handleOutput(chunk) {
  outputBuffer += chunk;
  const lines = outputBuffer.split(/\r?\n/);
  outputBuffer = lines.pop() ?? "";
  for (const line of lines) handleLine(line.trim());
}

function send(command) {
  if (!proc) throw new Error("Stockfish is not running");
  proc.stdin.write(`${command}\n`);
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`engine timeout waiting for ${label}`)), timeoutMs);
    listeners.push((line) => {
      if (predicate(line)) {
        clearTimeout(t);
        resolve(line);
        return true;
      }
      return false;
    });
  });
}

async function ensureReady() {
  if (proc) return;
  const file = enginePath();
  if (!file) throw new Error("stockfish WASM build not found (is the `stockfish` dependency installed?)");

  proc = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "ignore"] });
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", handleOutput);
  proc.on("error", (e) => failPending(e));
  proc.on("exit", (code, signal) => {
    proc = null;
    failPending(new Error(`Stockfish exited unexpectedly (${code ?? signal ?? "unknown"})`));
  });

  // Boot + handshake: ping `uci` on an interval until the engine answers —
  // writing a single `uci` before the WASM module finished init gets dropped.
  const ping = setInterval(() => {
    try { send("uci"); } catch { /* engine went away */ }
  }, 800);
  try {
    await waitFor((l) => l === "uciok", 60_000, "uciok");
    clearInterval(ping);
    send("isready");
    await waitFor((l) => l === "readyok", 60_000, "readyok");
  } catch (e) {
    clearInterval(ping);
    stopEngine();
    throw e;
  }
}
/** Evaluate a FEN at the given depth. The score is from the side to move's point of view (UCI convention). */
export function evaluate(fen, depth = 12) {
  // A failed search must not poison the chain for later callers.
  queue = queue.catch(() => {}).then(async () => {
    await ensureReady();
    if (pending) throw new Error("Stockfish is already searching");
    send(`position fen ${fen}`);
    const search = { info: [], resolve: null, reject: null, timeout: null };
    const result = new Promise((resolve, reject) => {
      search.resolve = resolve;
      search.reject = reject;
      search.timeout = setTimeout(() => {
        pending = null;
        stopEngine(); // a half-finished `go` would desync the next search
        reject(new Error("Stockfish search timed out"));
      }, 120_000);
    });
    pending = search;
    send(`go depth ${Math.min(Math.max(depth, 1), 20)}`);
    return result;
  });
  // Callers only ever see the engine's result, never the chain bookkeeping.
  return queue;
}

export function stopEngine() {
  if (!proc) return;
  try { send("quit"); } catch { /* already gone */ }
  proc.kill();
  proc = null;
}
