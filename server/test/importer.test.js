import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getGameWithMoments, isAnalyzed, listGames } from '../src/db.js';
import { FakeExplainer } from '../src/explainer/fake.js';
import { analyzeGame, importGame, importGames } from '../src/importer.js';
import { positionsFromPgn } from '../src/pgn.js';

const PGN = `[Event "Live Chess"]
[White "ExamplePlayer"]
[Black "Opponent"]
[Result "0-1"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 0-1`;

const RAW = {
  uuid: 'game-1',
  url: 'https://www.chess.com/game/live/1',
  pgn: PGN,
  time_class: 'rapid',
  end_time: 1788124673,
  white: { username: 'ExamplePlayer', rating: 229, result: 'checkmated' },
  black: { username: 'Opponent', rating: 310, result: 'win' },
};

// Returns evaluations in call order: analyzeGame walks plies 0..n in sequence.
function fakeEngine(evals) {
  let i = 0;
  return {
    calls: 0,
    async analyze() {
      this.calls += 1;
      const cp = evals[i++] ?? 0;
      return {
        evalWhite: cp,
        lines: [
          { multipv: 1, move: 'd2d4', pv: ['d2d4'], cpWhite: cp },
          { multipv: 2, move: 'g1f3', pv: ['g1f3'], cpWhite: cp - 10 },
        ],
      };
    },
  };
}

// 6 plies -> 7 positions. White's move at ply 2 drops 20 -> -400.
const EVALS = [20, 20, 20, -400, -400, -400, -400];

test('analyzeGame evaluates every position including the final one', async () => {
  const { moves, finalFen } = positionsFromPgn(PGN);
  const engine = fakeEngine(EVALS);
  const { evals, linesByPly } = await analyzeGame({ engine, moves, finalFen });

  assert.equal(engine.calls, moves.length + 1);
  assert.equal(evals.length, moves.length + 1);
  assert.equal(linesByPly[0][0].move, 'd2d4');
});

test('analyzeGame reports progress per position', async () => {
  const { moves, finalFen } = positionsFromPgn(PGN);
  const seen = [];
  await analyzeGame({
    engine: fakeEngine(EVALS),
    moves,
    finalFen,
    onPosition: (done, total) => seen.push([done, total]),
  });
  assert.equal(seen.length, 7);
  assert.deepEqual(seen.at(-1), [7, 7]);
});

test('importGame stores the game, its moments and their explanations', async () => {
  const db = openDb(':memory:');
  const got = await importGame({
    db,
    engine: fakeEngine(EVALS),
    explainer: new FakeExplainer(),
    username: 'ExamplePlayer',
    raw: RAW,
  });

  assert.equal(got.status, 'analyzed');
  assert.equal(got.moments, 1);

  const { game, moments } = getGameWithMoments(db, 'game-1');
  assert.equal(game.review_as_color, 'w');
  assert.equal(game.white_rating, 229);
  assert.equal(game.result, 'checkmated');
  assert.equal(game.time_class, 'rapid');

  assert.equal(moments.length, 1);
  assert.equal(moments[0].ply, 2);
  assert.equal(moments[0].played_move, 'Nf3');
  assert.equal(moments[0].centipawn_loss, 420);
  assert.equal(moments[0].kind, 'blunder');
  assert.equal(moments[0].teach_move, 'd2d4');
  assert.equal(moments[0].engineLines.length, 2);
  assert.match(moments[0].explanation.whatWentWrong, /Nf3/);

  assert.equal(isAnalyzed(db, 'game-1'), true);
});

test('importGame passes the moments to the explainer exactly once', async () => {
  const explainer = new FakeExplainer();
  await importGame({
    db: openDb(':memory:'), engine: fakeEngine(EVALS), explainer,
    username: 'ExamplePlayer', raw: RAW,
  });
  assert.equal(explainer.calls.length, 1);
  assert.equal(explainer.calls[0].moments.length, 1);
  assert.equal(explainer.calls[0].game.reviewAsColor, 'w');
});

test('importGame stores a moment with a null explanation when the explainer fails', async () => {
  const db = openDb(':memory:');
  await importGame({
    db, engine: fakeEngine(EVALS), explainer: new FakeExplainer({ fail: true }),
    username: 'ExamplePlayer', raw: RAW,
  });
  const { moments } = getGameWithMoments(db, 'game-1');
  assert.equal(moments.length, 1, 'the moment is still worth showing without prose');
  assert.equal(moments[0].explanation, null);
  assert.equal(moments[0].teach_move, null);
});

test('importGame skips a game that is already analyzed without touching the engine', async () => {
  const db = openDb(':memory:');
  const first = fakeEngine(EVALS);
  await importGame({ db, engine: first, explainer: new FakeExplainer(), username: 'ExamplePlayer', raw: RAW });

  const second = fakeEngine(EVALS);
  const got = await importGame({ db, engine: second, explainer: new FakeExplainer(), username: 'ExamplePlayer', raw: RAW });

  assert.equal(got.status, 'skipped');
  assert.equal(second.calls, 0);
});

test('importGame ignores a game the user did not play in', async () => {
  const db = openDb(':memory:');
  const got = await importGame({
    db, engine: fakeEngine(EVALS), explainer: new FakeExplainer(),
    username: 'SomeoneElse', raw: RAW,
  });
  assert.equal(got.status, 'not-players-game');
  assert.equal(listGames(db, 'SomeoneElse').length, 0);
});

test('importGames continues past a failing game and counts it', async () => {
  const db = openDb(':memory:');
  const exploding = {
    async analyze() { throw new Error('engine died'); },
  };
  const summary = await importGames({
    db,
    engine: exploding,
    explainer: new FakeExplainer(),
    username: 'ExamplePlayer',
    games: [RAW, { ...RAW, uuid: 'game-2' }],
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.analyzed, 0);
});

test('importGames reports progress for each game', async () => {
  const seen = [];
  await importGames({
    db: openDb(':memory:'),
    engine: fakeEngine([...EVALS, ...EVALS]),
    explainer: new FakeExplainer(),
    username: 'ExamplePlayer',
    games: [RAW],
    onProgress: (p) => seen.push(p),
  });
  assert.ok(seen.length >= 1);
  assert.equal(seen.at(-1).done, 1);
  assert.equal(seen.at(-1).total, 1);
  assert.equal(seen.at(-1).uuid, 'game-1');
});
