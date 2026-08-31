import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, stockfishAvailable } from '../src/engine.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Black's queen sits undefended on d4; White plays Nxd4 and wins it outright.
const FREE_QUEEN = 'rnb1kbnr/pppppppp/8/8/3q4/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 1';

const available = stockfishAvailable();
const opts = { skip: available ? false : 'stockfish not installed (brew install stockfish)' };

let engine;
before(async () => {
  if (!available) return;
  engine = new Engine({ depth: 10 });
  await engine.start();
});
after(async () => {
  if (engine) await engine.quit();
});

test('analyze returns MultiPV lines for the starting position', opts, async () => {
  const { evalWhite, lines } = await engine.analyze(START);
  assert.equal(lines.length, 3, 'expected MultiPV 3');
  assert.ok(Number.isInteger(evalWhite));
  assert.ok(Math.abs(evalWhite) < 150, `start position should be near equal, got ${evalWhite}`);
  assert.match(lines[0].move, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
});

test('analyze scores a winnable free queen strongly for White', opts, async () => {
  const { evalWhite } = await engine.analyze(FREE_QUEEN);
  assert.ok(evalWhite > 500, `expected a large White advantage, got ${evalWhite}`);
});

test('evaluateMove plays a legal move and scores the result', opts, async () => {
  const got = await engine.evaluateMove(FREE_QUEEN, 'f3d4');
  assert.equal(got.san, 'Nxd4');
  assert.ok(got.evalWhite > 500);
  assert.ok(got.fenAfter.includes(' b '));
});

test('evaluateMove returns null for an illegal move', opts, async () => {
  assert.equal(await engine.evaluateMove(START, 'e2e5'), null);
  assert.equal(await engine.evaluateMove(START, 'zzzz'), null);
});

test('stockfishAvailable reports false for a bogus path', () => {
  assert.equal(stockfishAvailable('/definitely/not/stockfish'), false);
});
