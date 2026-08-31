import { Chess } from 'chess.js';

/**
 * Read PGN tag pairs without going through chess.js, whose header accessor
 * has been renamed across versions.
 */
export function parseHeaders(pgn) {
  const headers = {};
  for (const m of pgn.matchAll(/^\[(\w+)\s+"([^"]*)"\]\s*$/gm)) {
    headers[m[1]] = m[2];
  }
  return headers;
}

/**
 * Replay the game, capturing the position *before* every move. The FEN at ply
 * i is the position the player was looking at when they chose move i, which is
 * exactly the position the review board needs to show.
 */
export function positionsFromPgn(pgn) {
  const parsed = new Chess();
  parsed.loadPgn(pgn);
  const history = parsed.history({ verbose: true });

  const board = new Chess();
  const moves = [];
  for (const m of history) {
    moves.push({
      ply: moves.length,
      fen: board.fen(),
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ''),
      color: m.color,
    });
    board.move(m.san);
  }

  return { moves, finalFen: board.fen() };
}

/** Which side was the given user? Returns null if they did not play. */
export function playerColorFor(headers, username) {
  const u = String(username).toLowerCase();
  if ((headers.White ?? '').toLowerCase() === u) return 'w';
  if ((headers.Black ?? '').toLowerCase() === u) return 'b';
  return null;
}
