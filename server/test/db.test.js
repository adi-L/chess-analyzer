import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, saveGame, saveMoments, listGames, getGameWithMoments,
  recordAttempt, markAnalyzed, isAnalyzed, getEtag, setEtag,
} from '../src/db.js';

const GAME = {
  uuid: 'abc-123',
  username: 'Crazy_Harp',
  url: 'https://www.chess.com/game/live/1',
  pgn: '[White "Crazy_Harp"]\n\n1. e4 *',
  white: 'Crazy_Harp',
  black: 'Opponent',
  whiteRating: 229,
  blackRating: 310,
  result: 'loss',
  timeClass: 'rapid',
  endTime: 1788124673,
  reviewAsColor: 'w',
};

const MOMENTS = [
  {
    ply: 10, fen: 'fen-10', playedMove: 'Bxh6', evalBefore: 30, evalAfter: -270,
    centipawnLoss: 300, kind: 'blunder',
    engineLines: [{ multipv: 1, move: 'f1e1', pv: ['f1e1'], cpWhite: 30 }],
    teachMove: 'Nxd5',
    explanation: { whatWentWrong: 'You left the knight where it could be taken.', whyBetter: 'Nxd5 wins a free knight.', pattern: 'hanging piece' },
  },
  {
    ply: 14, fen: 'fen-14', playedMove: 'Qh4', evalBefore: -100, evalAfter: -900,
    centipawnLoss: 800, kind: 'missed_win',
    engineLines: [], teachMove: 'Rxe8', explanation: null,
  },
];

function seeded() {
  const db = openDb(':memory:');
  saveGame(db, GAME);
  saveMoments(db, GAME.uuid, MOMENTS);
  return db;
}

test('saveGame then listGames returns the game with a moment count', () => {
  const db = seeded();
  const rows = listGames(db, 'Crazy_Harp');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, 'abc-123');
  assert.equal(rows[0].moment_count, 2);
  assert.equal(rows[0].time_class, 'rapid');
});

test('listGames is scoped by username', () => {
  const db = seeded();
  assert.equal(listGames(db, 'SomeoneElse').length, 0);
});

test('getGameWithMoments round-trips JSON columns and orders by ply', () => {
  const db = seeded();
  const { game, moments } = getGameWithMoments(db, 'abc-123');
  assert.equal(game.white, 'Crazy_Harp');
  assert.equal(game.review_as_color, 'w');
  assert.deepEqual(moments.map((m) => m.ply), [10, 14]);
  assert.equal(moments[0].engineLines[0].move, 'f1e1');
  assert.equal(moments[0].explanation.pattern, 'hanging piece');
  assert.equal(moments[1].explanation, null);
  assert.equal(moments[1].kind, 'missed_win');
});

test('getGameWithMoments returns null for an unknown game', () => {
  assert.equal(getGameWithMoments(openDb(':memory:'), 'nope'), null);
});

test('saveGame is idempotent and saveMoments replaces rather than duplicates', () => {
  const db = seeded();
  saveGame(db, GAME);
  saveMoments(db, GAME.uuid, MOMENTS);
  assert.equal(listGames(db, 'Crazy_Harp')[0].moment_count, 2);
});

test('markAnalyzed flips isAnalyzed', () => {
  const db = seeded();
  assert.equal(isAnalyzed(db, 'abc-123'), false);
  markAnalyzed(db, 'abc-123');
  assert.equal(isAnalyzed(db, 'abc-123'), true);
  assert.equal(isAnalyzed(db, 'missing'), false);
});

test('recordAttempt stores one row per guess', () => {
  const db = seeded();
  const { moments } = getGameWithMoments(db, 'abc-123');
  recordAttempt(db, moments[0].id, 'Nd5', 10);
  recordAttempt(db, moments[0].id, 'Nxd5', 250);
  const rows = db.prepare('SELECT move, eval FROM attempts ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.move), ['Nd5', 'Nxd5']);
  assert.equal(rows[1].eval, 250);
});

test('etags are stored and read back per archive url', () => {
  const db = openDb(':memory:');
  assert.equal(getEtag(db, 'https://x/2026/08'), null);
  setEtag(db, 'https://x/2026/08', 'W/"abc"');
  assert.equal(getEtag(db, 'https://x/2026/08'), 'W/"abc"');
  setEtag(db, 'https://x/2026/08', 'W/"def"');
  assert.equal(getEtag(db, 'https://x/2026/08'), 'W/"def"');
});
