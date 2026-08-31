import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonBlock, parseExplanations } from '../src/explainer/schema.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildRetryPrompt } from '../src/explainer/prompt.js';
import { FakeExplainer } from '../src/explainer/fake.js';

const GAME = { white: 'Crazy_Harp', black: 'Opponent', reviewAsColor: 'w', result: 'loss' };
const MOMENTS = [{
  ply: 20,
  fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5',
  playedMove: 'Bxf7+',
  evalBefore: 30,
  evalAfter: -280,
  centipawnLoss: 310,
  kind: 'blunder',
  engineLines: [
    { multipv: 1, move: 'd2d3', pv: ['d2d3'], cpWhite: 30 },
    { multipv: 2, move: 'f3g5', pv: ['f3g5'], cpWhite: 10 },
    { multipv: 3, move: 'b1c3', pv: ['b1c3'], cpWhite: 5 },
  ],
}];

test('extractJsonBlock reads a fenced json block', () => {
  const text = 'Sure!\n```json\n[{"ply":1}]\n```\nHope that helps.';
  assert.deepEqual(extractJsonBlock(text), [{ ply: 1 }]);
});

test('extractJsonBlock reads an unfenced array surrounded by prose', () => {
  assert.deepEqual(extractJsonBlock('Here you go: [{"ply":2}] done'), [{ ply: 2 }]);
});

test('extractJsonBlock returns null for junk', () => {
  assert.equal(extractJsonBlock('no json at all'), null);
  assert.equal(extractJsonBlock('```json\n{not valid}\n```'), null);
  assert.equal(extractJsonBlock(null), null);
});

test('parseExplanations accepts a well-formed array', () => {
  const text = JSON.stringify([{
    ply: 20, teachMove: 'd3', whatWentWrong: 'The bishop can just be taken.',
    whyBetter: 'd3 keeps the bishop safe.', pattern: 'hanging piece',
  }]);
  const got = parseExplanations(text);
  assert.equal(got.ok, true);
  assert.equal(got.data[0].teachMove, 'd3');
});

test('parseExplanations rejects a pattern that runs on into a paragraph', () => {
  const wordy = JSON.stringify([{
    ply: 20, teachMove: 'd3', whatWentWrong: 'ok', whyBetter: 'ok',
    pattern: 'Do not sacrifice a piece for a check unless you can see exactly how you win it back or deliver checkmate.',
  }]);
  const got = parseExplanations(wordy);
  assert.equal(got.ok, false, 'pattern must stay a short label');
});

test('parseExplanations rejects entries missing required fields', () => {
  const got = parseExplanations('[{"ply":20,"teachMove":"d3"}]');
  assert.equal(got.ok, false);
  assert.equal(typeof got.error, 'string');
});

test('parseExplanations rejects unparseable text', () => {
  const got = parseExplanations('I could not analyse this position.');
  assert.equal(got.ok, false);
});

test('SYSTEM_PROMPT targets a true beginner and demands JSON', () => {
  assert.match(SYSTEM_PROMPT, /beginner/i);
  assert.match(SYSTEM_PROMPT, /JSON/);
  // The register rule: do not lean on jargon the player has not learned.
  assert.match(SYSTEM_PROMPT, /jargon|plain language|do not assume/i);
});

test('buildUserPrompt includes every moment with its engine candidates', () => {
  const p = buildUserPrompt({ game: GAME, moments: MOMENTS });
  assert.match(p, /ply 20/i);
  assert.match(p, /Bxf7\+/);
  assert.match(p, /d2d3/);
  assert.match(p, /f3g5/);
  assert.match(p, /white/i);          // which side the player had
  assert.match(p, /-2\.8|-2\.80/);    // eval rendered in pawns, not raw centipawns
});

test('buildRetryPrompt restates the failure and the format', () => {
  const p = buildRetryPrompt({ game: GAME, moments: MOMENTS, error: 'ply: Required' });
  assert.match(p, /ply: Required/);
  assert.match(p, /JSON/);
});

test('FakeExplainer returns one aligned entry per moment', async () => {
  const got = await new FakeExplainer().explain({ game: GAME, moments: MOMENTS });
  assert.equal(got.length, 1);
  assert.equal(got[0].ply, 20);
  assert.equal(got[0].teachMove, 'd2d3');   // the top engine line
  assert.equal(typeof got[0].whatWentWrong, 'string');
});

test('FakeExplainer can be told to fail, yielding nulls', async () => {
  const got = await new FakeExplainer({ fail: true }).explain({ game: GAME, moments: MOMENTS });
  assert.deepEqual(got, [null]);
});

test('FakeExplainer handles an empty moment list', async () => {
  assert.deepEqual(await new FakeExplainer().explain({ game: GAME, moments: [] }), []);
});
