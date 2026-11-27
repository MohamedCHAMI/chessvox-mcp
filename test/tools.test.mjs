// Unit tests for chessvox-mcp tool logic. No network: the engine test skips
// itself when the stockfish WASM build is missing, mirroring the web repo.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, realpathSync } from "node:fs";

import { expectedScore, fideK, eloChange, glickoChange, ratingChanges } from "../src/elo.js";
import { withCredit, CREDIT } from "../src/credit.js";
import { OPENINGS } from "../src/openings-data.js";
import { enginePath } from "../src/engine.js";
import { validFen } from "../src/tools.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("elo math matches the site's formulas", () => {
  assert.equal(expectedScore(1500, 1500), 0.5);
  assert.equal(fideK(1500, 10), 40);
  assert.equal(fideK(1500, 30), 20);
  assert.equal(fideK(2400, 30), 10);
  // Even game with K=20: +10 / 0 / -10.
  const r = ratingChanges({ system: "fide", rating: 1500, opponent: 1500 });
  assert.ok(Math.abs(r.win - 10) < 1e-9, "win is +10");
  assert.equal(r.draw, 0);
  assert.ok(Math.abs(r.loss + 10) < 1e-9, "loss is -10");
  // Beating a much stronger opponent is a big gain.
  const up = eloChange(1500, 2000, "win", 20);
  assert.ok(up > 15, "underdog win pays well, got " + up);
  // Glicko estimate stays symmetric around a 0.5-expected matchup.
  const g = glickoChange(1500, 50, 1500, 50, "win");
  assert.ok(g > 0 && g < 15, "glicko even win is small and positive, got " + g);
});

test("every bundled opening has the fields the tool prints", () => {
  assert.equal(OPENINGS.length, 50);
  for (const o of OPENINGS) {
    assert.match(o.eco, /^[A-E]\d{2}$/);
    assert.ok(o.name.length > 2);
    assert.ok(Array.isArray(o.moves));
    assert.ok(o.slug.length > 1);
  }
});

test("opening lookup finds by eco prefix and name fragment", () => {
  const q = "b1";
  const byEco = OPENINGS.filter((o) => o.eco.toLowerCase().startsWith(q));
  assert.ok(byEco.length >= 1, "B1 prefix matches at least one opening");
  const byName = OPENINGS.filter((o) => o.name.toLowerCase().includes("london"));
  assert.ok(byName.length >= 1, "London System is bundled");
});

test("FEN validation accepts real positions and rejects junk", () => {
  assert.ok(validFen(START).ok);
  assert.ok(validFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").ok);
  assert.equal(validFen("not a fen").ok, false);
  assert.equal(validFen("").ok, false);
});

test("credit line is appended once and always present", () => {
  const s = withCredit("hello");
  assert.ok(s.startsWith("hello\n\nPowered by https://chessvox.com"));
  assert.equal(s.split(CREDIT.trim()).length - 1, 1);
});

test("stockfish WASM build is resolvable for best_move", { skip: !enginePath() && "stockfish dependency not installed" }, () => {
  assert.ok(enginePath().endsWith(".js"));
  assert.ok(existsSync(enginePath()));
});

test("enginePath resolves when stockfish is hoisted above the package (npm/npx layout)", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  assert.ok(enginePath(), "precondition: engine resolvable in this checkout");
  const dir = mkdtempSync(pathMod.join(tmpdir(), "chessvox-mcp-hoisted-"));
  mkdirSync(pathMod.join(dir, "node_modules", "chessvox-mcp", "src"), { recursive: true });
  mkdirSync(pathMod.join(dir, "node_modules", "stockfish", "bin"), { recursive: true });
  copyFileSync(new URL("../src/engine.js", import.meta.url), pathMod.join(dir, "node_modules", "chessvox-mcp", "src", "engine.js"));
  copyFileSync(enginePath(), pathMod.join(dir, "node_modules", "stockfish", "bin", "stockfish-19-lite-single.js"));
  const hoisted = await import(pathMod.join(dir, "node_modules", "chessvox-mcp", "src", "engine.js"));
  const found = hoisted.enginePath();
  assert.ok(found, "enginePath must find the hoisted stockfish");
  // macOS /tmp is a symlink to /private/tmp — compare realpaths.
  assert.equal(found, realpathSync(pathMod.join(dir, "node_modules", "stockfish", "bin", "stockfish-19-lite-single.js")));
});
