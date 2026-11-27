// Pure helpers shared by the MCP tools (no I/O here, so tests run offline).
import { Chess } from "chess.js";

export function validFen(fen) {
  try {
    const chess = new Chess(fen);
    return { ok: true, chess };
  } catch {
    return { ok: false };
  }
}
