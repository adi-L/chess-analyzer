import { parseHeaders, positionsFromPgn, playerColorFor } from './pgn.js';
import { selectMoments } from './moments.js';
import { saveGame, saveMoments, markAnalyzed, isAnalyzed, getEtag, setEtag } from './db.js';
import { recentGames } from './chesscom.js';

/** Evaluate every position in the game, including the final one. */
export async function analyzeGame({ engine, moves, finalFen, onPosition = () => {} }) {
  const positions = [...moves.map((m) => m.fen), finalFen];
  const evals = [];
  const linesByPly = [];

  for (let i = 0; i < positions.length; i++) {
    const { evalWhite, lines } = await engine.analyze(positions[i]);
    evals.push(evalWhite);
    linesByPly.push(lines);
    onPosition(i + 1, positions.length);
  }

  return { evals, linesByPly };
}

export async function importGame({ db, engine, explainer, username, raw, onPosition }) {
  if (isAnalyzed(db, raw.uuid)) return { status: 'skipped', uuid: raw.uuid, moments: 0 };

  const headers = parseHeaders(raw.pgn ?? '');
  const color = playerColorFor(headers, username);
  if (!color) return { status: 'not-players-game', uuid: raw.uuid, moments: 0 };

  const { moves, finalFen } = positionsFromPgn(raw.pgn);
  if (!moves.length) return { status: 'empty', uuid: raw.uuid, moments: 0 };

  const { evals, linesByPly } = await analyzeGame({ engine, moves, finalFen, onPosition });

  const selected = selectMoments({ evals, moves, playerColor: color })
    .map((m) => ({ ...m, engineLines: linesByPly[m.ply] ?? [] }));

  const side = color === 'w' ? raw.white : raw.black;
  const gameRow = {
    uuid: raw.uuid,
    username,
    url: raw.url,
    pgn: raw.pgn,
    white: raw.white?.username,
    black: raw.black?.username,
    whiteRating: raw.white?.rating,
    blackRating: raw.black?.rating,
    result: side?.result,
    timeClass: raw.time_class,
    endTime: raw.end_time,
    reviewAsColor: color,
  };

  const explanations = await explainer.explain({ game: gameRow, moments: selected });
  const enriched = selected.map((m, i) => ({
    ...m,
    teachMove: explanations[i]?.teachMove ?? null,
    explanation: explanations[i] ?? null,
  }));

  saveGame(db, gameRow);
  saveMoments(db, raw.uuid, enriched);
  markAnalyzed(db, raw.uuid);

  return { status: 'analyzed', uuid: raw.uuid, moments: enriched.length };
}

/**
 * Sequential by design: each game is written before the next starts, so a run
 * interrupted by a usage limit resumes cleanly instead of redoing work.
 */
export async function importGames({ db, engine, explainer, username, games, onProgress = () => {} }) {
  const summary = { analyzed: 0, skipped: 0, failed: 0, total: games.length };

  for (let i = 0; i < games.length; i++) {
    const raw = games[i];
    try {
      const result = await importGame({
        db, engine, explainer, username, raw,
        onPosition: (done, total) =>
          onProgress({ done: i, total: games.length, uuid: raw.uuid, phase: 'analyzing', positions: { done, total } }),
      });
      if (result.status === 'analyzed') summary.analyzed += 1;
      else summary.skipped += 1;
      onProgress({ done: i + 1, total: games.length, uuid: raw.uuid, phase: result.status, moments: result.moments });
    } catch (err) {
      summary.failed += 1;
      console.warn(`[import] ${raw.uuid} failed: ${err.message}`);
      onProgress({ done: i + 1, total: games.length, uuid: raw.uuid, phase: 'failed', error: err.message });
    }
  }

  return summary;
}

export async function fetchAndImport({
  db, engine, explainer, username, limit = 10, fetchImpl = fetch, onProgress = () => {},
}) {
  onProgress({ done: 0, total: 0, phase: 'fetching' });
  const games = await recentGames(username, {
    limit,
    fetchImpl,
    getEtag: (url) => getEtag(db, url),
    setEtag: (url, etag) => setEtag(db, url, etag),
  });
  return importGames({ db, engine, explainer, username, games, onProgress });
}
