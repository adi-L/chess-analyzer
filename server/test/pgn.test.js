import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeaders, positionsFromPgn, playerColorFor } from '../src/pgn.js';

const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.08.30"]
[White "ExamplePlayer"]
[Black "SomeOpponent"]
[Result "0-1"]
[TimeControl "600"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 0-1`;

test('parseHeaders reads the bracketed tag pairs', () => {
  const h = parseHeaders(PGN);
  assert.equal(h.White, 'ExamplePlayer');
  assert.equal(h.Black, 'SomeOpponent');
  assert.equal(h.Result, '0-1');
  assert.equal(h.TimeControl, '600');
});

test('positionsFromPgn yields one entry per ply with the pre-move FEN', () => {
  const { moves } = positionsFromPgn(PGN);
  assert.equal(moves.length, 6);

  assert.equal(moves[0].ply, 0);
  assert.equal(moves[0].san, 'e4');
  assert.equal(moves[0].uci, 'e2e4');
  assert.equal(moves[0].color, 'w');
  // Ply 0's FEN is the starting position, i.e. before e4 was played.
  assert.ok(moves[0].fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'));

  assert.equal(moves[1].san, 'e5');
  assert.equal(moves[1].color, 'b');
  // Ply 1's FEN is after e4 but before e5.
  assert.ok(moves[1].fen.includes(' b '));
  assert.ok(moves[1].fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'));

  assert.equal(moves[5].san, 'a6');
});

test('positionsFromPgn reports the final position', () => {
  const { finalFen } = positionsFromPgn(PGN);
  assert.ok(finalFen.includes('/'));
  assert.ok(finalFen.includes(' w ') || finalFen.includes(' b '));
});

test('playerColorFor matches the username case-insensitively', () => {
  const h = parseHeaders(PGN);
  assert.equal(playerColorFor(h, 'exampleplayer'), 'w');
  assert.equal(playerColorFor(h, 'EXAMPLEPLAYER'), 'w');
  assert.equal(playerColorFor(h, 'someopponent'), 'b');
  assert.equal(playerColorFor(h, 'nobody'), null);
});

test('positionsFromPgn records promotion in the uci string', () => {
  const promo = `[White "A"]
[Black "B"]

1. e4 d5 2. exd5 Nf6 3. d6 Bg4 4. dxc7 Qc8 5. cxb8=Q Rxb8 *`;
  const { moves } = positionsFromPgn(promo);
  const promotion = moves.find((m) => m.san.includes('=Q'));
  assert.ok(promotion, 'expected a promotion move in the game');
  assert.equal(promotion.uci.length, 5);
  assert.ok(promotion.uci.endsWith('q'));
});
