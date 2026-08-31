export const MATE_SCORE = 100000;

/**
 * Parse one Stockfish `info` line. Returns null for lines that carry no
 * evaluation (`bestmove`, `info string ...`, partial search lines).
 */
export function parseInfoLine(line) {
  if (!line.startsWith('info ')) return null;
  const t = line.trim().split(/\s+/);
  let depth = null;
  let multipv = 1;
  let score = null;
  let pv = [];

  for (let i = 1; i < t.length; i++) {
    if (t[i] === 'depth') {
      depth = Number(t[++i]);
    } else if (t[i] === 'multipv') {
      multipv = Number(t[++i]);
    } else if (t[i] === 'score') {
      const type = t[++i];
      const value = Number(t[++i]);
      if (type !== 'cp' && type !== 'mate') return null;
      score = { type, value };
    } else if (t[i] === 'pv') {
      pv = t.slice(i + 1);
      break;
    }
  }

  if (depth === null || score === null) return null;
  if (!Number.isFinite(depth) || !Number.isFinite(multipv) || !Number.isFinite(score.value)) return null;
  return { depth, multipv, score, pv };
}

/** Keep the deepest info line per multipv index, ordered by index. */
export function collectBestLines(lines) {
  const byIndex = new Map();
  for (const line of lines) {
    const info = parseInfoLine(line);
    if (!info) continue;
    const prev = byIndex.get(info.multipv);
    if (!prev || info.depth >= prev.depth) byIndex.set(info.multipv, info);
  }
  return [...byIndex.values()].sort((a, b) => a.multipv - b.multipv);
}

/** Collapse a UCI score into a single signed centipawn number. */
export function toCentipawns(score) {
  if (score.type === 'mate') {
    return score.value > 0 ? MATE_SCORE - score.value : -MATE_SCORE - score.value;
  }
  return score.value;
}

/** UCI scores are from the side-to-move's view; normalise to White's view. */
export function toWhitePov(cp, sideToMove) {
  return sideToMove === 'w' ? cp : -cp;
}
