import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfoLine, collectBestLines, toCentipawns, toWhitePov, MATE_SCORE } from '../src/uci.js';

test('parseInfoLine extracts depth, multipv, cp score and pv', () => {
  const line = 'info depth 14 seldepth 18 multipv 1 score cp 34 nodes 12345 nps 100000 time 123 pv e2e4 e7e5 g1f3';
  assert.deepEqual(parseInfoLine(line), {
    depth: 14,
    multipv: 1,
    score: { type: 'cp', value: 34 },
    pv: ['e2e4', 'e7e5', 'g1f3'],
  });
});

test('parseInfoLine handles mate scores and bound tokens', () => {
  const line = 'info depth 20 multipv 2 score mate 3 lowerbound nodes 99 pv d1h5';
  const got = parseInfoLine(line);
  assert.deepEqual(got.score, { type: 'mate', value: 3 });
  assert.deepEqual(got.pv, ['d1h5']);
});

test('parseInfoLine returns null for non-info and incomplete lines', () => {
  assert.equal(parseInfoLine('bestmove e2e4 ponder e7e5'), null);
  assert.equal(parseInfoLine('info depth 5 nodes 20'), null);
  assert.equal(parseInfoLine('info string NNUE evaluation using nn-x.nnue'), null);
});

test('collectBestLines keeps the deepest entry per multipv index and sorts by index', () => {
  const lines = [
    'info depth 8 multipv 1 score cp 10 pv a2a3',
    'info depth 8 multipv 2 score cp 5 pv b2b3',
    'info depth 14 multipv 2 score cp 7 pv b2b4',
    'info depth 14 multipv 1 score cp 34 pv e2e4',
    'bestmove e2e4',
  ];
  const got = collectBestLines(lines);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((l) => l.multipv), [1, 2]);
  assert.equal(got[0].score.value, 34);
  assert.equal(got[1].pv[0], 'b2b4');
});

test('toCentipawns maps mate to a large signed value that beats any cp score', () => {
  assert.equal(toCentipawns({ type: 'cp', value: 250 }), 250);
  assert.equal(toCentipawns({ type: 'mate', value: 3 }), MATE_SCORE - 3);
  assert.equal(toCentipawns({ type: 'mate', value: -2 }), -MATE_SCORE + 2);
  assert.ok(toCentipawns({ type: 'mate', value: 9 }) > toCentipawns({ type: 'cp', value: 5000 }));
});

test('toWhitePov flips the sign when Black is to move', () => {
  assert.equal(toWhitePov(120, 'w'), 120);
  assert.equal(toWhitePov(120, 'b'), -120);
});
