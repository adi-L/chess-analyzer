import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  uuid            TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  url             TEXT,
  pgn             TEXT NOT NULL,
  white           TEXT,
  black           TEXT,
  white_rating    INTEGER,
  black_rating    INTEGER,
  result          TEXT,
  time_class      TEXT,
  end_time        INTEGER,
  review_as_color TEXT NOT NULL,
  analyzed_at     INTEGER
);

CREATE TABLE IF NOT EXISTS moments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_uuid      TEXT NOT NULL REFERENCES games(uuid) ON DELETE CASCADE,
  ply            INTEGER NOT NULL,
  fen            TEXT NOT NULL,
  played_move    TEXT NOT NULL,
  eval_before    INTEGER,
  eval_after     INTEGER,
  centipawn_loss INTEGER NOT NULL,
  engine_lines   TEXT NOT NULL,
  teach_move     TEXT,
  explanation    TEXT,
  kind           TEXT NOT NULL,
  UNIQUE(game_uuid, ply)
);

CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id  INTEGER NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  move       TEXT NOT NULL,
  eval       INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
  url        TEXT PRIMARY KEY,
  etag       TEXT,
  fetched_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_moments_game ON moments(game_uuid);
CREATE INDEX IF NOT EXISTS idx_games_user ON games(username, end_time DESC);
`;

export function openDb(file = process.env.CHESS_DB || 'chess.db') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function saveGame(db, g) {
  db.prepare(`
    INSERT INTO games (uuid, username, url, pgn, white, black, white_rating,
                       black_rating, result, time_class, end_time, review_as_color)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(uuid) DO UPDATE SET
      username = excluded.username,
      url = excluded.url,
      pgn = excluded.pgn,
      white = excluded.white,
      black = excluded.black,
      white_rating = excluded.white_rating,
      black_rating = excluded.black_rating,
      result = excluded.result,
      time_class = excluded.time_class,
      end_time = excluded.end_time,
      review_as_color = excluded.review_as_color
  `).run(
    g.uuid, g.username, g.url ?? null, g.pgn, g.white ?? null, g.black ?? null,
    g.whiteRating ?? null, g.blackRating ?? null, g.result ?? null,
    g.timeClass ?? null, g.endTime ?? null, g.reviewAsColor,
  );
}

export function markAnalyzed(db, uuid) {
  db.prepare('UPDATE games SET analyzed_at = ? WHERE uuid = ?').run(Date.now(), uuid);
}

export function isAnalyzed(db, uuid) {
  const row = db.prepare('SELECT analyzed_at FROM games WHERE uuid = ?').get(uuid);
  return Boolean(row && row.analyzed_at);
}

export function saveMoments(db, gameUuid, moments) {
  if (moments.length === 0) {
    db.prepare('DELETE FROM moments WHERE game_uuid = ?').run(gameUuid);
    return;
  }
  const plies = moments.map((m) => m.ply);
  const placeholders = plies.map(() => '?').join(',');
  db.prepare(`DELETE FROM moments WHERE game_uuid = ? AND ply NOT IN (${placeholders})`)
    .run(gameUuid, ...plies);

  const upsert = db.prepare(`
    INSERT INTO moments (game_uuid, ply, fen, played_move, eval_before, eval_after,
                         centipawn_loss, engine_lines, teach_move, explanation, kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_uuid, ply) DO UPDATE SET
      fen = excluded.fen,
      played_move = excluded.played_move,
      eval_before = excluded.eval_before,
      eval_after = excluded.eval_after,
      centipawn_loss = excluded.centipawn_loss,
      engine_lines = excluded.engine_lines,
      teach_move = excluded.teach_move,
      explanation = excluded.explanation,
      kind = excluded.kind
  `);
  for (const m of moments) {
    upsert.run(
      gameUuid, m.ply, m.fen, m.playedMove,
      m.evalBefore ?? null, m.evalAfter ?? null, m.centipawnLoss,
      JSON.stringify(m.engineLines ?? []),
      m.teachMove ?? null,
      m.explanation ? JSON.stringify(m.explanation) : null,
      m.kind,
    );
  }
}

export function listGames(db, username) {
  return db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM moments m WHERE m.game_uuid = g.uuid) AS moment_count
    FROM games g
    WHERE g.username = ?
    ORDER BY g.end_time DESC
  `).all(username);
}

export function getGameWithMoments(db, uuid) {
  const game = db.prepare('SELECT * FROM games WHERE uuid = ?').get(uuid);
  if (!game) return null;
  const rows = db.prepare('SELECT * FROM moments WHERE game_uuid = ? ORDER BY ply').all(uuid);
  const moments = rows.map((r) => ({
    ...r,
    engineLines: JSON.parse(r.engine_lines),
    explanation: r.explanation ? JSON.parse(r.explanation) : null,
  }));
  return { game, moments };
}

export function recordAttempt(db, momentId, move, evalWhite) {
  db.prepare('INSERT INTO attempts (moment_id, move, eval, created_at) VALUES (?,?,?,?)')
    .run(momentId, move, evalWhite ?? null, Date.now());
}

export function getEtag(db, url) {
  const row = db.prepare('SELECT etag FROM archives WHERE url = ?').get(url);
  return row ? row.etag : null;
}

export function setEtag(db, url, etag) {
  db.prepare(`
    INSERT INTO archives (url, etag, fetched_at) VALUES (?,?,?)
    ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, fetched_at = excluded.fetched_at
  `).run(url, etag ?? null, Date.now());
}
