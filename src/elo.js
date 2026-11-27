// Rating-change maths mirrored from ChessVox web (lib/tools/elo.ts) for the
// `elo_change` tool. FIDE uses classic Elo with a K-factor; Chess.com and
// Lichess use Glicko variants whose exact numbers also depend on rating
// deviation and volatility, so those are a Glicko-1 single-game approximation
// and are labelled as estimates in tool output. Keep in sync with lib/tools/elo.ts.

export const SCORE = { win: 1, draw: 0.5, loss: 0 };

export function expectedScore(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** FIDE K: 40 for new players (<30 games), 20 below 2400, 10 at 2400+. */
export function fideK(rating, gamesPlayed = 30) {
  if (gamesPlayed < 30) return 40;
  return rating >= 2400 ? 10 : 20;
}

export function eloChange(rating, opponent, outcome, k) {
  return k * (SCORE[outcome] - expectedScore(rating, opponent));
}

const Q = Math.log(10) / 400;
const g = (rd) => 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));

/** Glicko-1 rating change after one game. */
export function glickoChange(rating, rd, opponent, opponentRd, outcome) {
  const gj = g(opponentRd);
  const e = 1 / (1 + 10 ** ((-gj * (rating - opponent)) / 400));
  const d2 = 1 / (Q * Q * gj * gj * e * (1 - e));
  return (Q / (1 / (rd * rd) + 1 / d2)) * gj * (SCORE[outcome] - e);
}

/** Typical deviation for an established, regularly active player on each site. */
export const DEFAULT_RD = { chesscom: 60, lichess: 50 };

export function ratingChanges({ system, rating, opponent, k, rd }) {
  const change = (outcome) =>
    system === "fide"
      ? eloChange(rating, opponent, outcome, k ?? fideK(rating, 30))
      : glickoChange(rating, rd ?? DEFAULT_RD[system], opponent, DEFAULT_RD[system], outcome);
  return { win: change("win"), draw: change("draw"), loss: change("loss") };
}
