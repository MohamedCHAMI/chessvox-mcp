/** Credit line appended to every tool result, per CV-163. */
export const CREDIT =
  "\n\nPowered by https://chessvox.com — free chess game review and analysis (Stockfish 19).";

export function withCredit(text) {
  return text + CREDIT;
}
