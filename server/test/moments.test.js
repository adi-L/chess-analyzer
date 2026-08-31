import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMoments } from '../src/moments.js';

// Build `moves` scaffolding of the requested length. White moves are even plies.
function makeMoves(n) {
  return Array.from({ length: n }, (_, i) => ({
    ply: i,
    fen: `fen-${i}`,
    san: `M${i}`,
    uci: `m${i}`,
    color: i % 2 === 0 ? 'w' : 'b',
  }));
}

test('flags a White blunder and reports the loss from White POV', () => {
  // Ply 0 (White) drops the eval from +20 to -300 => 320cp loss.
  const evals = [20, -300, -290];
  const got = selectMoments({ evals, moves: makeMoves(2), playerColor: 'w' });
  assert.equal(got.length, 1);
  assert.equal(got[0].ply, 0);
  assert.equal(got[0].centipawnLoss, 320);
  assert.equal(got[0].kind, 'blunder');
  assert.equal(got[0].fen, 'fen-0');
});

test('flags a Black blunder using inverted signs', () => {
  // Ply 1 (Black) moves the eval from -20 to +400 => 420cp loss for Black.
  const evals = [0, -20, 400];
  const got = selectMoments({ evals, moves: makeMoves(2), playerColor: 'b' });
  assert.equal(got.length, 1);
  assert.equal(got[0].ply, 1);
  assert.equal(got[0].centipawnLoss, 420);
});

test('ignores moves made by the opponent', () => {
  // Only ply 1 (Black) is bad; the player is White, so nothing is flagged.
  const evals = [0, 10, -500];
  const got = selectMoments({ evals, moves: makeMoves(2), playerColor: 'w' });
  assert.deepEqual(got, []);
});

test('applies the 100cp floor', () => {
  const evals = [0, -99, -99];
  assert.deepEqual(selectMoments({ evals, moves: makeMoves(2), playerColor: 'w' }), []);

  const worse = [0, -100, -100];
  assert.equal(selectMoments({ evals: worse, moves: makeMoves(2), playerColor: 'w' }).length, 1);
});

test('skips positions where the player was already losing by more than 600cp', () => {
  // White is at -700 before moving; the further drop must not be flagged.
  const evals = [-700, -1500, -1500];
  assert.deepEqual(selectMoments({ evals, moves: makeMoves(2), playerColor: 'w' }), []);

  // At exactly -600 the position is still reviewable.
  const borderline = [-600, -1400, -1400];
  assert.equal(selectMoments({ evals: borderline, moves: makeMoves(2), playerColor: 'w' }).length, 1);
});

test('tags a blunder that follows an opponent blunder as missed_win', () => {
  // Ply 0 White fine. Ply 1 Black hangs a queen (+900 for White).
  // Ply 2 White fails to take, giving it all back.
  const evals = [0, 0, 900, 0, 0];
  const got = selectMoments({ evals, moves: makeMoves(4), playerColor: 'w' });
  assert.equal(got.length, 1);
  assert.equal(got[0].ply, 2);
  assert.equal(got[0].kind, 'missed_win');
});

test('keeps the five worst moments and returns them in replay order', () => {
  // Six White blunders of increasing severity on plies 0,2,4,6,8,10.
  const losses = [150, 250, 350, 450, 550, 650];
  const evals = [0];
  losses.forEach((loss) => {
    const before = evals[evals.length - 1];
    evals.push(before - loss); // White's move loses ground
    evals.push(before - loss); // Black replies neutrally
  });
  const got = selectMoments({ evals, moves: makeMoves(12), playerColor: 'w', lostCp: 100000 });
  assert.equal(got.length, 5);
  assert.deepEqual(got.map((m) => m.ply), [2, 4, 6, 8, 10]); // the 150cp one is dropped
  assert.deepEqual(got.map((m) => m.centipawnLoss), [250, 350, 450, 550, 650]);
});

test('returns fewer than five when fewer qualify, and never throws on a short game', () => {
  assert.deepEqual(selectMoments({ evals: [0], moves: [], playerColor: 'w' }), []);
  const got = selectMoments({ evals: [0, -400, -400], moves: makeMoves(2), playerColor: 'w' });
  assert.equal(got.length, 1);
});

test('tolerates missing evaluations without throwing', () => {
  const evals = [0, null, -900];
  assert.deepEqual(selectMoments({ evals, moves: makeMoves(2), playerColor: 'w' }), []);
});
