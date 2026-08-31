export const DEFAULTS = {
  floorCp: 100,
  lostCp: 600,
  maxMoments: 5,
  opponentBlunderCp: 300,
};

/**
 * Choose the moves worth teaching from a fully evaluated game.
 *
 * Ranking rather than a fixed threshold: at beginner ratings almost every move
 * clears a fixed bar, so we take the N worst instead. The same code surfaces
 * subtler mistakes unchanged as the player improves.
 */
export function selectMoments({
  evals,
  moves,
  playerColor,
  floorCp = DEFAULTS.floorCp,
  lostCp = DEFAULTS.lostCp,
  maxMoments = DEFAULTS.maxMoments,
  opponentBlunderCp = DEFAULTS.opponentBlunderCp,
}) {
  const sign = playerColor === 'w' ? 1 : -1;

  // Ground lost by whoever moved at ply i, from that mover's point of view.
  const lossFor = (i, moverSign) => {
    const before = evals[i];
    const after = evals[i + 1];
    if (before == null || after == null) return null;
    return moverSign * (before - after);
  };

  const isPlayerMove = (i) => (playerColor === 'w' ? i % 2 === 0 : i % 2 === 1);

  const candidates = [];
  for (let i = 0; i < moves.length; i++) {
    if (!isPlayerMove(i)) continue;
    if (evals[i] == null) continue;

    // Already decisively lost: nothing left to learn from this move.
    if (sign * evals[i] < -lostCp) continue;

    const loss = lossFor(i, sign);
    if (loss == null || loss < floorCp) continue;

    // Did the opponent just blunder, and we failed to punish it?
    const opponentLoss = i > 0 ? lossFor(i - 1, -sign) : null;
    const kind =
      opponentLoss != null && opponentLoss >= opponentBlunderCp ? 'missed_win' : 'blunder';

    candidates.push({
      ply: i,
      fen: moves[i].fen,
      playedMove: moves[i].san,
      evalBefore: evals[i],
      evalAfter: evals[i + 1],
      centipawnLoss: loss,
      kind,
    });
  }

  return candidates
    .sort((a, b) => b.centipawnLoss - a.centipawnLoss)
    .slice(0, maxMoments)
    .sort((a, b) => a.ply - b.ply);
}
