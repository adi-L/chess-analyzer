import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonBlock, parseExplanations } from '../src/explainer/schema.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildRetryPrompt } from '../src/explainer/prompt.js';
import { FakeExplainer } from '../src/explainer/fake.js';

const GAME = { white: 'ExamplePlayer', black: 'Opponent', reviewAsColor: 'w', result: 'loss' };
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

import { extractResult, ClaudeCliExplainer, CLI_FLAGS, sanitizedEnv } from '../src/explainer/claudeCli.js';

const OK_JSON = JSON.stringify([{
  ply: 20, teachMove: 'd2d3', whatWentWrong: 'The bishop could just be taken.',
  whyBetter: 'd2d3 keeps it defended.', pattern: 'hanging piece',
}]);

const envelope = (result, isError = false) =>
  JSON.stringify({ is_error: isError, result, usage: { output_tokens: 1 } });

// Fake `runClaude`: yields the given texts in order, recording what it was asked.
function fakeRun(texts, seen = []) {
  let call = 0;
  return async (args) => {
    seen.push(args);
    return texts[Math.min(call++, texts.length - 1)];
  };
}

test('extractResult reads the result field out of the CLI envelope', () => {
  assert.equal(extractResult(envelope('hello')), 'hello');
});

test('extractResult tolerates warning lines printed before the JSON', () => {
  const noisy = 'Warning: no stdin data received in 3s, proceeding without it.\n' + envelope('hello');
  assert.equal(extractResult(noisy), 'hello');
});

test('extractResult throws when the CLI reports an error', () => {
  assert.throws(() => extractResult(envelope('boom', true)), /claude cli reported an error/i);
});

test('extractResult throws on output that is not an envelope', () => {
  assert.throws(() => extractResult('command not found'), /could not parse/i);
});

test('CLI_FLAGS strip the harness', () => {
  assert.ok(CLI_FLAGS.includes('--max-turns'));
  assert.ok(CLI_FLAGS.includes('--output-format'));
  assert.ok(CLI_FLAGS.includes('json'));
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(CLI_FLAGS.includes(tool), `${tool} must be disallowed`);
  }
});

test('ClaudeCliExplainer parses a good response and passes the right arguments', async () => {
  const seen = [];
  const explainer = new ClaudeCliExplainer({ runImpl: fakeRun([OK_JSON], seen) });
  const got = await explainer.explain({ game: GAME, moments: MOMENTS });

  assert.equal(got.length, 1);
  assert.equal(got[0].teachMove, 'd2d3');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'claude-opus-5');
  assert.equal(seen[0].systemPrompt, SYSTEM_PROMPT);
  assert.match(seen[0].prompt, /ply 20/);
});

test('ClaudeCliExplainer retries once on unparseable output', async () => {
  const seen = [];
  const explainer = new ClaudeCliExplainer({ runImpl: fakeRun(['sorry, no', OK_JSON], seen) });
  const got = await explainer.explain({ game: GAME, moments: MOMENTS });

  assert.equal(seen.length, 2);
  assert.match(seen[1].prompt, /could not be parsed/);
  assert.equal(got[0].teachMove, 'd2d3');
});

test('ClaudeCliExplainer yields nulls after the retry also fails', async () => {
  const explainer = new ClaudeCliExplainer({ runImpl: fakeRun(['nope', 'still nope']) });
  assert.deepEqual(await explainer.explain({ game: GAME, moments: MOMENTS }), [null]);
});

test('ClaudeCliExplainer aligns responses to moments by ply, filling gaps with null', async () => {
  const twoMoments = [MOMENTS[0], { ...MOMENTS[0], ply: 34 }];
  const explainer = new ClaudeCliExplainer({ runImpl: fakeRun([OK_JSON]) }); // only ply 20
  const got = await explainer.explain({ game: GAME, moments: twoMoments });
  assert.equal(got.length, 2);
  assert.equal(got[0].ply, 20);
  assert.equal(got[1], null);
});

test('ClaudeCliExplainer makes no call for an empty moment list', async () => {
  const seen = [];
  const explainer = new ClaudeCliExplainer({ runImpl: fakeRun([OK_JSON], seen) });
  assert.deepEqual(await explainer.explain({ game: GAME, moments: [] }), []);
  assert.equal(seen.length, 0);
});

test('ClaudeCliExplainer survives a run that throws', async () => {
  const explainer = new ClaudeCliExplainer({
    runImpl: async () => { throw new Error('usage limit reached'); },
  });
  assert.deepEqual(await explainer.explain({ game: GAME, moments: MOMENTS }), [null]);
});

test('sanitizedEnv strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN', () => {
  const fakeEnv = {
    ANTHROPIC_API_KEY: 'sk-ant-fake',
    ANTHROPIC_AUTH_TOKEN: 'fake-token',
    PATH: '/usr/bin',
    HOME: '/home/user',
  };
  const got = sanitizedEnv(fakeEnv);
  assert.equal('ANTHROPIC_API_KEY' in got, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in got, false);
  assert.equal(got.PATH, '/usr/bin');
  assert.equal(got.HOME, '/home/user');
  // Must not mutate the object it was given.
  assert.equal(fakeEnv.ANTHROPIC_API_KEY, 'sk-ant-fake');
});

test('sanitizedEnv is a no-op when the keys are already absent', () => {
  const fakeEnv = { PATH: '/usr/bin' };
  const got = sanitizedEnv(fakeEnv);
  assert.deepEqual(got, { PATH: '/usr/bin' });
});

test('sanitizedEnv does not throw on an empty env', () => {
  assert.deepEqual(sanitizedEnv({}), {});
});
