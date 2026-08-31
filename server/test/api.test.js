import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';
import { openDb, saveGame, saveMoments, getGameWithMoments } from '../src/db.js';
import { FakeExplainer } from '../src/explainer/fake.js';

const db = openDb(':memory:');
const engine = {
  async analyze() { return { evalWhite: 15, lines: [] }; },
  async evaluateMove(fen, uci) {
    if (uci !== 'e2e4') return null;
    return { san: 'e4', fenAfter: 'after-fen', evalWhite: 42 };
  },
};

let server;
let base;

before(async () => {
  saveGame(db, {
    uuid: 'g1', username: 'ExamplePlayer', url: 'u', pgn: '[White "ExamplePlayer"]\n\n1. e4 *',
    white: 'ExamplePlayer', black: 'Opp', whiteRating: 229, blackRating: 300,
    result: 'checkmated', timeClass: 'rapid', endTime: 100, reviewAsColor: 'w',
  });
  saveMoments(db, 'g1', [{
    ply: 4, fen: 'some-fen', playedMove: 'Nf3', evalBefore: 20, evalAfter: -400,
    centipawnLoss: 420, kind: 'blunder', engineLines: [], teachMove: 'd2d4',
    explanation: { ply: 4, teachMove: 'd2d4', whatWentWrong: 'x', whyBetter: 'y', pattern: 'z' },
  }]);

  const app = createApp({ db, engine, explainer: new FakeExplainer(), username: 'ExamplePlayer' });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('GET /api/games lists the stored games with moment counts', async () => {
  const res = await fetch(`${base}/api/games`);
  assert.equal(res.status, 200);
  const { games } = await res.json();
  assert.equal(games.length, 1);
  assert.equal(games[0].uuid, 'g1');
  assert.equal(games[0].moment_count, 1);
});

test('GET /api/games/:uuid returns the game with its moments', async () => {
  const res = await fetch(`${base}/api/games/g1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.game.uuid, 'g1');
  assert.equal(body.moments[0].ply, 4);
  assert.equal(body.moments[0].explanation.pattern, 'z');
});

test('GET /api/games/:uuid 404s for an unknown game', async () => {
  const res = await fetch(`${base}/api/games/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not found');
});

test('POST /api/evaluate scores a legal move', async () => {
  const res = await fetch(`${base}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: 'start-fen', move: 'e2e4' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { san: 'e4', fenAfter: 'after-fen', evalWhite: 42 });
});

test('POST /api/evaluate 400s on an illegal move', async () => {
  const res = await fetch(`${base}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: 'start-fen', move: 'a1a8' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'illegal move');
});

test('POST /api/evaluate records an attempt when momentId is given', async () => {
  const { moments } = getGameWithMoments(db, 'g1');
  await fetch(`${base}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: 'start-fen', move: 'e2e4', momentId: moments[0].id }),
  });
  const rows = db.prepare('SELECT move, eval FROM attempts WHERE moment_id = ?').all(moments[0].id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].move, 'e4');
  assert.equal(rows[0].eval, 42);
});

test('GET /api/import streams progress and finishes with a done event', async () => {
  const res = await fetch(`${base}/api/import?limit=0`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: done/);
});
