# Chess Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost tool that replays a chess.com game, stops at the five moments that decided it, quizzes the player on what they should have played, and explains the answer in beginner language.

**Architecture:** Node server owns a long-lived native Stockfish process (UCI over stdio) and a SQLite cache; a React frontend is a board that replays cached analysis and posts quiz attempts back for live evaluation. Explanations come from spawning the `claude` CLI, which runs on the user's existing subscription — no API key anywhere. All selection logic (ranking, thresholds, teaching-move choice) lives in pure functions testable without an engine or network.

**Tech Stack:** Node 24 (ESM, built-in `node:test` and `node:sqlite`), Express, chess.js, zod, the `claude` CLI (subscription auth), Vite + React + react-chessboard, Stockfish native binary.

**Spec:** `docs/superpowers/specs/2026-08-31-chess-analyzer-design.md`

## Global Constraints

- Node **24+** required — the plan uses built-in `node:sqlite` (`DatabaseSync`) and `node:test`. No `better-sqlite3`, no test framework dependency.
- All server code is **ESM** (`"type": "module"` in `server/package.json`). Use `import`, never `require`.
- Chess.com API: **serial requests only** (parallel requests return 429). Every request must send a `User-Agent` carrying contact info, read from `CHESS_CONTACT` (chess.com blocks anonymous clients). Anonymous clients are blocked.
- Engine defaults: **depth 14**, **MultiPV 3**.
- Moment selection: **100cp floor**, **600cp already-lost skip**, **max 5 moments** per game, **300cp opponent-blunder threshold** for `missed_win`.
- Default username: **`ExamplePlayer`** (env `CHESS_USERNAME`).
- Stockfish path: env `STOCKFISH_PATH`, default `stockfish` on PATH.
- Claude model: **`claude-opus-5`**. Do not change without instruction.
- Every `claude` invocation must pass `--system-prompt` (replacing the base prompt, not appending), `--max-turns 1`, and the `--disallowed-tools` list. Measured harness overhead is ~22.6k input tokens per call; it is prompt-cached, so import runs should batch games rather than run one at a time.
- **No API key, ever.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` must stay unset — either one silently redirects billing from the subscription to the API.
- Never build a live-assistance feature. Post-game analysis only.
- Scores are stored as **centipawns from White's point of view**. Mate is mapped to `±(100000 - plies_to_mate)`.

---

## File Structure

```
chess/
├── server/
│   ├── package.json
│   └── src/
│   │   ├── uci.js           Parse Stockfish output. Pure.
│   │   ├── moments.js       Rank and select teaching moments. Pure.
│   │   ├── pgn.js           PGN -> per-ply positions. Pure.
│   │   ├── engine.js        Stockfish subprocess, UCI protocol.
│   │   ├── db.js            SQLite schema and queries.
│   │   ├── chesscom.js      Chess.com API client.
│   │   ├── explainer/
│   │   │   ├── schema.js    Zod schema for explanation JSON.
│   │   │   ├── fake.js      Deterministic explainer for tests.
│   │   │   ├── prompt.js    System prompt + user prompt builder.
│   │   │   └── claudeCli.js Explainer that spawns the claude CLI.
│   │   ├── importer.js      Orchestrates fetch -> analyze -> select -> explain -> store.
│   │   └── index.js         Express app and routes.
│   └── test/
│       ├── uci.test.js
│       ├── moments.test.js
│       ├── pgn.test.js
│       ├── db.test.js
│       ├── chesscom.test.js
│       ├── explainer.test.js
│       ├── importer.test.js
│       └── engine.integration.test.js
└── web/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── api.js
        ├── GameList.jsx
        └── Review.jsx
```

Split is by responsibility, not layer. The three pure modules (`uci`, `moments`, `pgn`) carry the logic worth testing and have no I/O. `engine`, `db`, `chesscom`, and `explainer/claudeCli` are thin adapters over the outside world, each fakeable at its boundary.

---

### Task 1: Project scaffold and UCI parser

Stockfish emits `info` lines during search. This task turns that text into structured evaluations. It is pure — no subprocess, no network — so it is the right place to establish the project and the test loop at the same time.

**Files:**
- Create: `server/package.json`
- Create: `server/src/uci.js`
- Test: `server/test/uci.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseInfoLine(line: string) => {depth: number, multipv: number, score: {type: 'cp'|'mate', value: number}, pv: string[]} | null`
  - `collectBestLines(lines: string[]) => Array<same shape>` sorted by `multipv` ascending, keeping the deepest entry per multipv index
  - `toCentipawns(score) => number` — mate mapped to `±(100000 - n)`
  - `toWhitePov(cp: number, sideToMove: 'w'|'b') => number`
  - `MATE_SCORE = 100000`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "chess-analyzer-server",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test test/",
    "start": "node src/index.js"
  },
  "dependencies": {
    "chess.js": "^1.4.0",
    "express": "^5.1.0",
    "zod": "^3.25.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd server && npm install`
Expected: `node_modules/` created, no errors. There is no Anthropic npm dependency — explanations go through the `claude` binary. Confirm it is present and authenticated:

```bash
claude --version && claude -p 'Reply with exactly: OK' --max-turns 1 < /dev/null
```

Expected: a version string, then `OK`. If this fails, run `claude` once interactively and log in before continuing.

- [ ] **Step 3: Write the failing test**

Create `server/test/uci.test.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/uci.js'`.

- [ ] **Step 5: Write the implementation**

Create `server/src/uci.js`:

```js
export const MATE_SCORE = 100000;

/**
 * Parse one Stockfish `info` line. Returns null for lines that carry no
 * evaluation (`bestmove`, `info string ...`, partial search lines).
 */
export function parseInfoLine(line) {
  if (!line.startsWith('info ')) return null;
  const t = line.trim().split(/\s+/);
  let depth = null;
  let multipv = 1;
  let score = null;
  let pv = [];

  for (let i = 1; i < t.length; i++) {
    if (t[i] === 'depth') {
      depth = Number(t[++i]);
    } else if (t[i] === 'multipv') {
      multipv = Number(t[++i]);
    } else if (t[i] === 'score') {
      const type = t[++i];
      const value = Number(t[++i]);
      if (type !== 'cp' && type !== 'mate') return null;
      score = { type, value };
    } else if (t[i] === 'pv') {
      pv = t.slice(i + 1);
      break;
    }
  }

  if (depth === null || score === null) return null;
  return { depth, multipv, score, pv };
}

/** Keep the deepest info line per multipv index, ordered by index. */
export function collectBestLines(lines) {
  const byIndex = new Map();
  for (const line of lines) {
    const info = parseInfoLine(line);
    if (!info) continue;
    const prev = byIndex.get(info.multipv);
    if (!prev || info.depth >= prev.depth) byIndex.set(info.multipv, info);
  }
  return [...byIndex.values()].sort((a, b) => a.multipv - b.multipv);
}

/** Collapse a UCI score into a single signed centipawn number. */
export function toCentipawns(score) {
  if (score.type === 'mate') {
    return score.value > 0 ? MATE_SCORE - score.value : -MATE_SCORE - score.value;
  }
  return score.value;
}

/** UCI scores are from the side-to-move's view; normalise to White's view. */
export function toWhitePov(cp, sideToMove) {
  return sideToMove === 'w' ? cp : -cp;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS — 6 tests.

- [ ] **Step 7: Commit**

```bash
printf 'node_modules/\ndist/\n*.db\n*.sqlite\n.env\n.DS_Store\n' > .gitignore
git add .gitignore server/package.json server/package-lock.json server/src/uci.js server/test/uci.test.js
git commit -m "feat(engine): parse Stockfish UCI info lines"
```

---

### Task 2: Teaching-moment selector

The heart of the tool. Given the evaluation of every position in a game, decide which five moves are worth stopping at. Pure function over plain arrays — no engine needed.

**Files:**
- Create: `server/src/moments.js`
- Test: `server/test/moments.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `selectMoments({evals, moves, playerColor, floorCp?, lostCp?, maxMoments?, opponentBlunderCp?}) => Moment[]`
  - `Moment = {ply, fen, playedMove, evalBefore, evalAfter, centipawnLoss, kind}` where `kind` is `'blunder' | 'missed_win'`
  - `evals` is length `moves.length + 1`, White-POV centipawns; `evals[i]` is the position *before* ply `i`.
  - `moves[i] = {ply, fen, san, uci, color}` where `fen` is the position before the move.
  - Returned moments are sorted by `ply` ascending (replay order), selected by `centipawnLoss` descending.

- [ ] **Step 1: Write the failing test**

Create `server/test/moments.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/moments.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/moments.js`:

```js
export const DEFAULTS = {
  floorCp: 100,
  lostCp: 600,
  maxMoments: 5,
  opponentBlunderCp: 300,
};

/**
 * Choose the moves worth teaching from a fully evaluated game.
 *
 * Ranking rather than a fixed threshold: at beginner ratings almost every move
 * clears a fixed bar, so we take the N worst instead. The same code surfaces
 * subtler mistakes unchanged as the player improves.
 */
export function selectMoments({
  evals,
  moves,
  playerColor,
  floorCp = DEFAULTS.floorCp,
  lostCp = DEFAULTS.lostCp,
  maxMoments = DEFAULTS.maxMoments,
  opponentBlunderCp = DEFAULTS.opponentBlunderCp,
}) {
  const sign = playerColor === 'w' ? 1 : -1;

  // Ground lost by whoever moved at ply i, from that mover's point of view.
  const lossFor = (i, moverSign) => {
    const before = evals[i];
    const after = evals[i + 1];
    if (before == null || after == null) return null;
    return moverSign * (before - after);
  };

  const isPlayerMove = (i) => (playerColor === 'w' ? i % 2 === 0 : i % 2 === 1);

  const candidates = [];
  for (let i = 0; i < moves.length; i++) {
    if (!isPlayerMove(i)) continue;
    if (evals[i] == null) continue;

    // Already decisively lost: nothing left to learn from this move.
    if (sign * evals[i] < -lostCp) continue;

    const loss = lossFor(i, sign);
    if (loss == null || loss < floorCp) continue;

    // Did the opponent just blunder, and we failed to punish it?
    const opponentLoss = i > 0 ? lossFor(i - 1, -sign) : null;
    const kind =
      opponentLoss != null && opponentLoss >= opponentBlunderCp ? 'missed_win' : 'blunder';

    candidates.push({
      ply: i,
      fen: moves[i].fen,
      playedMove: moves[i].san,
      evalBefore: evals[i],
      evalAfter: evals[i + 1],
      centipawnLoss: loss,
      kind,
    });
  }

  return candidates
    .sort((a, b) => b.centipawnLoss - a.centipawnLoss)
    .slice(0, maxMoments)
    .sort((a, b) => a.ply - b.ply);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS — all `uci` and `moments` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/moments.js server/test/moments.test.js
git commit -m "feat(analysis): rank and select teaching moments"
```

---

### Task 3: PGN to per-ply positions

Turn a chess.com PGN into the `moves` array `selectMoments` expects, plus the headers needed to work out which colour the player had.

**Files:**
- Create: `server/src/pgn.js`
- Test: `server/test/pgn.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseHeaders(pgn: string) => Record<string, string>`
  - `positionsFromPgn(pgn: string) => {moves: Move[], finalFen: string}` where `Move = {ply, fen, san, uci, color}` and `fen` is the position **before** that move
  - `playerColorFor(headers, username: string) => 'w' | 'b' | null` (case-insensitive)

Headers are parsed with a regex rather than chess.js so the code does not depend on which of `header()` / `getHeaders()` the installed chess.js version exposes.

- [ ] **Step 1: Write the failing test**

Create `server/test/pgn.test.js`:

```js
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

1. e4 d5 2. exd5 Nf6 3. d6 Bg4 4. dxc7 Nbd7 5. cxb8=Q Rxb8 *`;
  const { moves } = positionsFromPgn(promo);
  const promotion = moves.find((m) => m.san.includes('=Q'));
  assert.ok(promotion, 'expected a promotion move in the game');
  assert.equal(promotion.uci.length, 5);
  assert.ok(promotion.uci.endsWith('q'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/pgn.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/pgn.js`:

```js
import { Chess } from 'chess.js';

/**
 * Read PGN tag pairs without going through chess.js, whose header accessor
 * has been renamed across versions.
 */
export function parseHeaders(pgn) {
  const headers = {};
  for (const m of pgn.matchAll(/^\[(\w+)\s+"([^"]*)"\]\s*$/gm)) {
    headers[m[1]] = m[2];
  }
  return headers;
}

/**
 * Replay the game, capturing the position *before* every move. The FEN at ply
 * i is the position the player was looking at when they chose move i, which is
 * exactly the position the review board needs to show.
 */
export function positionsFromPgn(pgn) {
  const parsed = new Chess();
  parsed.loadPgn(pgn);
  const history = parsed.history({ verbose: true });

  const board = new Chess();
  const moves = [];
  for (const m of history) {
    moves.push({
      ply: moves.length,
      fen: board.fen(),
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ''),
      color: m.color,
    });
    board.move(m.san);
  }

  return { moves, finalFen: board.fen() };
}

/** Which side was the given user? Returns null if they did not play. */
export function playerColorFor(headers, username) {
  const u = String(username).toLowerCase();
  if ((headers.White ?? '').toLowerCase() === u) return 'w';
  if ((headers.Black ?? '').toLowerCase() === u) return 'b';
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS. If `loadPgn` is undefined, the installed chess.js is v0.x — reinstall with `npm i chess.js@^1.4.0` and rerun.

- [ ] **Step 5: Commit**

```bash
git add server/src/pgn.js server/test/pgn.test.js
git commit -m "feat(analysis): convert PGN into per-ply positions"
```

---

### Task 4: Stockfish engine wrapper

Own one long-lived Stockfish subprocess and speak UCI to it. Two capabilities: evaluate a position (batch analysis) and evaluate a specific candidate move (live quiz answers).

**Files:**
- Create: `server/src/engine.js`
- Test: `server/test/engine.integration.test.js`

**Interfaces:**
- Consumes: `collectBestLines`, `toCentipawns`, `toWhitePov` from `src/uci.js`.
- Produces:
  - `class Engine` with `constructor({path?, depth?, multipv?})`, `async start()`, `async analyze(fen) => {evalWhite: number|null, lines: Line[]}`, `async evaluateMove(fen, uciMove) => {san, fenAfter, evalWhite} | null`, `async quit()`
  - `Line = {multipv: number, move: string|null, pv: string[], cpWhite: number}`
  - `stockfishAvailable(path?) => boolean`
  - `evalWhite` is always centipawns from White's point of view.

- [ ] **Step 1: Write the failing integration test**

Create `server/test/engine.integration.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/engine.js'`.

- [ ] **Step 3: Install Stockfish**

Run: `brew install stockfish && stockfish --help 2>&1 | head -3`
Expected: the binary responds. If Homebrew is unavailable, download a build from stockfishchess.org and set `STOCKFISH_PATH` to it. Without it the engine tests skip rather than fail, but Task 9 cannot be verified end to end.

- [ ] **Step 4: Write the implementation**

Create `server/src/engine.js`:

```js
import { spawn, spawnSync } from 'node:child_process';
import { Chess } from 'chess.js';
import { collectBestLines, toCentipawns, toWhitePov } from './uci.js';

const DEFAULT_PATH = process.env.STOCKFISH_PATH || 'stockfish';

/** Cheap probe so tests can skip rather than fail when the binary is absent. */
export function stockfishAvailable(path = DEFAULT_PATH) {
  const probe = spawnSync(path, ['--help'], { timeout: 5000 });
  return !probe.error;
}

export class Engine {
  #proc = null;
  #buffer = '';
  #waiters = [];

  constructor({ path = DEFAULT_PATH, depth = 14, multipv = 3 } = {}) {
    this.path = path;
    this.depth = depth;
    this.multipv = multipv;
  }

  async start() {
    this.#proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => this.#onData(chunk));

    await this.#command('uci', (l) => l === 'uciok');
    this.#send(`setoption name MultiPV value ${this.multipv}`);
    await this.#command('isready', (l) => l === 'readyok');
    return this;
  }

  async analyze(fen) {
    const sideToMove = fen.split(' ')[1];
    this.#send(`position fen ${fen}`);
    const output = await this.#command(`go depth ${this.depth}`, (l) => l.startsWith('bestmove'));

    const lines = collectBestLines(output).map((l) => ({
      multipv: l.multipv,
      move: l.pv[0] ?? null,
      pv: l.pv,
      cpWhite: toWhitePov(toCentipawns(l.score), sideToMove),
    }));

    return { evalWhite: lines.length ? lines[0].cpWhite : null, lines };
  }

  /** Apply a UCI move to a position and evaluate what it leads to. */
  async evaluateMove(fen, uciMove) {
    if (typeof uciMove !== 'string' || uciMove.length < 4) return null;
    const board = new Chess(fen);
    let move = null;
    try {
      move = board.move({
        from: uciMove.slice(0, 2),
        to: uciMove.slice(2, 4),
        promotion: uciMove.slice(4) || undefined,
      });
    } catch {
      return null;
    }
    if (!move) return null;

    const { evalWhite } = await this.analyze(board.fen());
    return { san: move.san, fenAfter: board.fen(), evalWhite };
  }

  async quit() {
    if (!this.#proc) return;
    this.#send('quit');
    const proc = this.#proc;
    this.#proc = null;
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000).unref();
    });
  }

  #send(cmd) {
    this.#proc.stdin.write(cmd + '\n');
  }

  /** Register the waiter *before* writing, otherwise fast replies are missed. */
  #command(cmd, predicate) {
    const done = new Promise((resolve) => this.#waiters.push({ predicate, lines: [], resolve }));
    this.#send(cmd);
    return done;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    this.#buffer = parts.pop();
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const waiter = this.#waiters[0];
      if (!waiter) continue;
      waiter.lines.push(line);
      if (waiter.predicate(line)) {
        this.#waiters.shift();
        waiter.resolve(waiter.lines);
      }
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS. If Stockfish is not installed the four engine tests report as skipped, not failed.

- [ ] **Step 6: Commit**

```bash
git add server/src/engine.js server/test/engine.integration.test.js
git commit -m "feat(engine): Stockfish subprocess wrapper over UCI"
```

---

### Task 5: SQLite persistence

Cache everything so analysis is never repeated. Uses Node 24's built-in `node:sqlite` — no native module to compile.

**Files:**
- Create: `server/src/db.js`
- Test: `server/test/db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openDb(file?) => Database` — creates the schema if absent; pass `':memory:'` in tests
  - `saveGame(db, game) => void` where `game = {uuid, username, url, pgn, white, black, whiteRating, blackRating, result, timeClass, endTime, reviewAsColor}`
  - `markAnalyzed(db, uuid) => void`
  - `isAnalyzed(db, uuid) => boolean`
  - `saveMoments(db, gameUuid, moments) => void` — replaces any existing moments for that game
  - `listGames(db, username) => Row[]` — newest first, each row carries `moment_count`
  - `getGameWithMoments(db, uuid) => {game, moments} | null`
  - `recordAttempt(db, momentId, move, evalWhite) => void`
  - `getEtag(db, url) => string | null` / `setEtag(db, url, etag) => void`

- [ ] **Step 1: Write the failing test**

Create `server/test/db.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, saveGame, saveMoments, listGames, getGameWithMoments,
  recordAttempt, markAnalyzed, isAnalyzed, getEtag, setEtag,
} from '../src/db.js';

const GAME = {
  uuid: 'abc-123',
  username: 'ExamplePlayer',
  url: 'https://www.chess.com/game/live/1',
  pgn: '[White "ExamplePlayer"]\n\n1. e4 *',
  white: 'ExamplePlayer',
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
  const rows = listGames(db, 'ExamplePlayer');
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
  assert.equal(game.white, 'ExamplePlayer');
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
  assert.equal(listGames(db, 'ExamplePlayer')[0].moment_count, 2);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/db.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/db.js`:

```js
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
  db.prepare('DELETE FROM moments WHERE game_uuid = ?').run(gameUuid);
  const insert = db.prepare(`
    INSERT INTO moments (game_uuid, ply, fen, played_move, eval_before, eval_after,
                         centipawn_loss, engine_lines, teach_move, explanation, kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const m of moments) {
    insert.run(
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS. Node prints an `ExperimentalWarning` for `node:sqlite`; that is expected and harmless.

- [ ] **Step 5: Commit**

```bash
git add server/src/db.js server/test/db.test.js
git commit -m "feat(db): SQLite schema and queries via node:sqlite"
```

---

### Task 6: Chess.com API client

Fetch game archives. Serial requests, mandatory User-Agent, ETag-conditional so past months are fetched once.

**Files:**
- Create: `server/src/chesscom.js`
- Test: `server/test/chesscom.test.js`

**Interfaces:**
- Consumes: nothing (the caller injects `fetchImpl` and the ETag store).
- Produces:
  - `USER_AGENT` constant
  - `listArchives(username, {fetchImpl?}) => string[]` — archive URLs, oldest first
  - `fetchMonth(url, {etag?, fetchImpl?}) => {notModified: boolean, games: object[], etag: string|null}`
  - `recentGames(username, {limit?, fetchImpl?, getEtag?, setEtag?}) => object[]` — newest first, walks archives backwards and stops once `limit` games are collected

- [ ] **Step 1: Write the failing test**

Create `server/test/chesscom.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listArchives, fetchMonth, recentGames, USER_AGENT } from '../src/chesscom.js';

function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, headers: init.headers ?? {} });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    return {
      ok: route.status < 400,
      status: route.status,
      headers: new Map(Object.entries(route.headers ?? {})),
      json: async () => route.body,
    };
  };
}

const ARCHIVES_URL = 'https://api.chess.com/pub/player/exampleplayer/games/archives';

test('listArchives returns the archive urls and sends the User-Agent', async () => {
  const log = [];
  const fetchImpl = fakeFetch({
    [ARCHIVES_URL]: { status: 200, body: { archives: ['u/2026/07', 'u/2026/08'] } },
  }, log);

  const got = await listArchives('exampleplayer', { fetchImpl });
  assert.deepEqual(got, ['u/2026/07', 'u/2026/08']);
  assert.equal(log[0].headers['User-Agent'], USER_AGENT);
});

test('fetchMonth returns games and the etag', async () => {
  const fetchImpl = fakeFetch({
    'u/2026/08': { status: 200, headers: { etag: 'W/"x"' }, body: { games: [{ uuid: '1' }] } },
  });
  const got = await fetchMonth('u/2026/08', { fetchImpl });
  assert.equal(got.notModified, false);
  assert.equal(got.etag, 'W/"x"');
  assert.deepEqual(got.games, [{ uuid: '1' }]);
});

test('fetchMonth sends If-None-Match and reports 304 as notModified', async () => {
  const log = [];
  const fetchImpl = fakeFetch({ 'u/2026/07': { status: 304, body: {} } }, log);
  const got = await fetchMonth('u/2026/07', { etag: 'W/"old"', fetchImpl });
  assert.equal(got.notModified, true);
  assert.deepEqual(got.games, []);
  assert.equal(log[0].headers['If-None-Match'], 'W/"old"');
});

test('recentGames walks archives newest-first and stops at the limit', async () => {
  const log = [];
  const fetchImpl = fakeFetch({
    [ARCHIVES_URL]: { status: 200, body: { archives: ['u/2026/06', 'u/2026/07', 'u/2026/08'] } },
    'u/2026/08': { status: 200, body: { games: [{ uuid: 'g3', end_time: 30 }, { uuid: 'g2', end_time: 20 }] } },
    'u/2026/07': { status: 200, body: { games: [{ uuid: 'g1', end_time: 10 }] } },
    'u/2026/06': { status: 200, body: { games: [{ uuid: 'g0', end_time: 5 }] } },
  }, log);

  const got = await recentGames('exampleplayer', { limit: 3, fetchImpl });
  assert.deepEqual(got.map((g) => g.uuid), ['g3', 'g2', 'g1']);
  // June must never be requested — the limit was reached in July.
  assert.equal(log.some((e) => e.url === 'u/2026/06'), false);
});

test('recentGames issues requests strictly one at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const body = url.endsWith('archives')
      ? { archives: ['u/2026/07', 'u/2026/08'] }
      : { games: [{ uuid: url, end_time: 1 }] };
    return { ok: true, status: 200, headers: new Map(), json: async () => body };
  };

  await recentGames('exampleplayer', { limit: 10, fetchImpl });
  assert.equal(maxInFlight, 1, 'parallel requests to chess.com return 429');
});

test('recentGames uses the etag store when one is supplied', async () => {
  const store = new Map([['u/2026/08', 'W/"cached"']]);
  const log = [];
  const fetchImpl = fakeFetch({
    [ARCHIVES_URL]: { status: 200, body: { archives: ['u/2026/08'] } },
    'u/2026/08': { status: 304, body: {} },
  }, log);

  const got = await recentGames('exampleplayer', {
    limit: 5,
    fetchImpl,
    getEtag: (url) => store.get(url) ?? null,
    setEtag: (url, etag) => store.set(url, etag),
  });
  assert.deepEqual(got, []);
  assert.equal(log[1].headers['If-None-Match'], 'W/"cached"');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/chesscom.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/chesscom.js`:

```js
export const USER_AGENT = buildUserAgent(process.env.CHESS_CONTACT);
const BASE = 'https://api.chess.com/pub';

function headerOf(res, name) {
  // Works with both a real Headers object and a Map in tests.
  if (typeof res.headers?.get === 'function') return res.headers.get(name);
  return null;
}

export async function listArchives(username, { fetchImpl = fetch } = {}) {
  const url = `${BASE}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`chess.com archives request failed: ${res.status}`);
  const body = await res.json();
  return body.archives ?? [];
}

export async function fetchMonth(url, { etag = null, fetchImpl = fetch } = {}) {
  const headers = { 'User-Agent': USER_AGENT };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetchImpl(url, { headers });
  if (res.status === 304) return { notModified: true, games: [], etag };
  if (!res.ok) throw new Error(`chess.com month request failed: ${res.status} (${url})`);

  const body = await res.json();
  return { notModified: false, games: body.games ?? [], etag: headerOf(res, 'etag') };
}

/**
 * Newest games first. Archives are walked backwards and requested one at a
 * time — chess.com returns 429 for concurrent requests from one IP.
 */
export async function recentGames(username, {
  limit = 10,
  fetchImpl = fetch,
  getEtag = () => null,
  setEtag = () => {},
} = {}) {
  const archives = await listArchives(username, { fetchImpl });
  const collected = [];

  for (let i = archives.length - 1; i >= 0 && collected.length < limit; i--) {
    const url = archives[i];
    const { notModified, games, etag } = await fetchMonth(url, { etag: getEtag(url), fetchImpl });
    if (!notModified) setEtag(url, etag);
    const sorted = [...games].sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0));
    collected.push(...sorted);
  }

  return collected.slice(0, limit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/chesscom.js server/test/chesscom.test.js
git commit -m "feat(chesscom): serial, etag-aware archive client"
```

---

### Task 7: Explanation contract — schema, prompt, fake

Define what an explanation *is* before wiring up Claude. Everything here is pure and testable, and the `FakeExplainer` unblocks Task 9 without touching the network.

**Files:**
- Create: `server/src/explainer/schema.js`
- Create: `server/src/explainer/prompt.js`
- Create: `server/src/explainer/fake.js`
- Test: `server/test/explainer.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractJsonBlock(text) => unknown | null` — tolerates fenced blocks and surrounding prose
  - `ExplanationSchema`, `ExplanationsSchema` (zod)
  - `parseExplanations(text) => {ok: true, data: Explanation[]} | {ok: false, error: string}`
  - `Explanation = {ply, teachMove, whatWentWrong, whyBetter, pattern}`
  - `SYSTEM_PROMPT: string`
  - `buildUserPrompt({game, moments}) => string`
  - `buildRetryPrompt({game, moments, error}) => string`
  - `class FakeExplainer` with `async explain({game, moments}) => (Explanation|null)[]` aligned to `moments`
  - **The Explainer contract:** `explain({game, moments})` resolves to an array the same length and order as `moments`, each entry an `Explanation` or `null`.

- [ ] **Step 1: Write the failing test**

Create `server/test/explainer.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/explainer/schema.js'`.

- [ ] **Step 3: Write the schema module**

Create `server/src/explainer/schema.js`:

```js
import { z } from 'zod';

export const ExplanationSchema = z.object({
  ply: z.number().int().nonnegative(),
  teachMove: z.string().min(2),
  whatWentWrong: z.string().min(1).max(400),
  whyBetter: z.string().min(1).max(600),
  // Verified against a live call: without a ceiling the model writes a
  // paragraph here. Exceeding it fails validation and triggers the retry.
  pattern: z.string().min(1).max(40),
});

export const ExplanationsSchema = z.array(ExplanationSchema);

/**
 * Pull a JSON array out of a model response. There is no output-format
 * guarantee on this path, so the text may be fenced, prefixed with prose,
 * or both.
 */
export function extractJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseExplanations(text) {
  const raw = extractJsonBlock(text);
  if (raw === null) return { ok: false, error: 'no JSON array found in response' };
  const result = ExplanationsSchema.safeParse(raw);
  if (!result.success) {
    const error = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error };
  }
  return { ok: true, data: result.data };
}
```

- [ ] **Step 4: Write the prompt module**

Create `server/src/explainer/prompt.js`:

```js
const pawns = (cp) => (cp == null ? 'unknown' : (cp / 100).toFixed(2));

export const SYSTEM_PROMPT = `You are a chess coach explaining mistakes to a complete beginner (rating around 250).

You will be given positions from one of their games. For each position you get:
- the move they actually played and what it did to the evaluation
- the top three moves the engine prefers, with evaluations

Your job for each position:
1. Choose the move to teach. This is NOT automatically the engine's first
   choice. Pick the strongest move a beginner could plausibly have found -
   usually a capture, a check, or saving a piece that was about to be lost.
   A free piece at +0.1 is a far better lesson than a quiet rook move at +0.3.
   The move you name must be one of the engine moves you were given.
2. Say what went wrong, in one sentence.
3. Say why the better move works, in one or two sentences.
4. Name the pattern in two or three words.

Register rules - this matters more than anything else:
- Write in plain language for someone who has just started playing.
- Do not assume chess jargon means anything to them. Avoid "development",
  "initiative", "the exchange", "prophylaxis", "the center" as explanations
  in themselves.
- Say concretely which piece can take what. Good: "Your knight on f6 can be
  taken by the bishop on g5, and you have nothing that can take back."
  Bad: "This weakens your kingside structure."
- Never scold. State what happened and what to look for next time.

Respond with a JSON array and nothing else. One object per position, in the
order given, each with exactly these keys:
  "ply"            - the ply number you were given, as a number
  "teachMove"      - the move to teach, exactly as written in the engine list
  "whatWentWrong"  - one sentence
  "whyBetter"      - one or two sentences
  "pattern"        - two or three words ONLY, e.g. "hanging piece",
                     "missed capture", "back rank". Not a sentence.

Output only the JSON array. No preamble, no commentary after it.`;

function describeMoment(m, colorName) {
  const lines = (m.engineLines ?? [])
    .map((l) => `    ${l.move}  (${pawns(l.cpWhite)})`)
    .join('\n');

  const kindNote = m.kind === 'missed_win'
    ? '\n  NOTE: the opponent had just blundered here. This is a missed opportunity, not only a mistake.'
    : '';

  return `- ply ${m.ply} (${colorName} to move)
  position (FEN): ${m.fen}
  they played: ${m.playedMove}
  evaluation before: ${pawns(m.evalBefore)}   after: ${pawns(m.evalAfter)}   (positive favours White)
  engine's top moves:
${lines}${kindNote}`;
}

export function buildUserPrompt({ game, moments }) {
  const colorName = game.reviewAsColor === 'w' ? 'White' : 'Black';
  return `The player had the ${colorName} pieces. Game result: ${game.result ?? 'unknown'}.
All evaluations below are in pawns from White's point of view.

Positions to explain (${moments.length}):

${moments.map((m) => describeMoment(m, colorName)).join('\n\n')}

Return the JSON array now.`;
}

export function buildRetryPrompt({ game, moments, error }) {
  return `${buildUserPrompt({ game, moments })}

Your previous response could not be parsed. The problem was: ${error}
Return ONLY a valid JSON array with one object per position, each having the
keys ply, teachMove, whatWentWrong, whyBetter, pattern. No other text.`;
}
```

- [ ] **Step 5: Write the fake explainer**

Create `server/src/explainer/fake.js`:

```js
/**
 * Deterministic stand-in for the real explainer. Used by tests so the
 * importer can be exercised without spawning Claude.
 */
export class FakeExplainer {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.calls = [];
  }

  async explain({ game, moments }) {
    this.calls.push({ game, moments });
    return moments.map((m) => {
      if (this.fail) return null;
      const top = m.engineLines?.[0]?.move ?? m.playedMove;
      return {
        ply: m.ply,
        teachMove: top,
        whatWentWrong: `${m.playedMove} lost ${(m.centipawnLoss / 100).toFixed(1)} pawns.`,
        whyBetter: `${top} keeps the position level.`,
        pattern: m.kind === 'missed_win' ? 'missed capture' : 'hanging piece',
      };
    });
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/explainer server/test/explainer.test.js
git commit -m "feat(explainer): explanation schema, beginner prompt, test fake"
```

---

### Task 8: Claude CLI explainer

The real explainer. One call per game covering all moments, on the user's Claude
subscription, by spawning the `claude` binary that is already installed and
already authenticated.

**Why the CLI rather than `@anthropic-ai/claude-agent-sdk`:** the SDK spawns this
same binary underneath. Driving it directly removes an npm dependency, and the
exact invocation below was verified working on this machine before the plan was
written. Measured overhead is ~22.6k input tokens per call — the Claude Code
harness rides along even with `--system-prompt` replacing the base prompt and
tools disallowed. That overhead is prompt-cached, so one import run covering
several games costs far less than the same games imported one at a time.

**Files:**
- Create: `server/src/explainer/claudeCli.js`
- Modify: `server/test/explainer.test.js` (append)

**Interfaces:**
- Consumes: `parseExplanations` from `./schema.js`; `SYSTEM_PROMPT`, `buildUserPrompt`, `buildRetryPrompt` from `./prompt.js`.
- Produces:
  - `CLI_FLAGS` — the frozen argument list that strips the harness
  - `extractResult(stdout) => string` — pure; pulls `result` out of the CLI's JSON envelope
  - `runClaude({prompt, systemPrompt, model, bin?, timeoutMs?}) => Promise<string>`
  - `class ClaudeCliExplainer` with `constructor({model?, runImpl?, maxRetries?})` and `async explain({game, moments}) => (Explanation|null)[]`
  - Satisfies the same Explainer contract as `FakeExplainer`: same length and order as `moments`, `null` where no explanation could be produced.

`runImpl` is injected so the class is testable without spawning anything.

- [ ] **Step 1: Append the failing tests**

Append to `server/test/explainer.test.js`:

```js
import { extractResult, ClaudeCliExplainer, CLI_FLAGS } from '../src/explainer/claudeCli.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/explainer/claudeCli.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/explainer/claudeCli.js`:

```js
import { spawn } from 'node:child_process';
import { parseExplanations } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildRetryPrompt } from './prompt.js';

/**
 * Claude Code carries its own tools and scaffolding. For a single text call we
 * want none of it: one turn, no tools, machine-readable output.
 */
export const CLI_FLAGS = Object.freeze([
  '--max-turns', '1',
  '--output-format', 'json',
  '--disallowed-tools',
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task',
]);

/** Pull the assistant text out of the CLI's JSON envelope. */
export function extractResult(stdout) {
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error(`could not parse claude output: ${stdout.slice(0, 200)}`);

  let envelope;
  try {
    envelope = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`could not parse claude output: ${stdout.slice(0, 200)}`);
  }

  if (envelope.is_error) throw new Error(`claude cli reported an error: ${envelope.result ?? ''}`);
  return envelope.result ?? '';
}

/**
 * Spawn `claude -p`. Credentials resolve exactly as they do for the interactive
 * CLI, so this runs on the user's subscription. stdin is closed - the CLI waits
 * on it otherwise and prints a warning after three seconds.
 */
export function runClaude({ prompt, systemPrompt, model, bin = process.env.CLAUDE_BIN || 'claude', timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--system-prompt', systemPrompt, '--model', model, ...CLI_FLAGS];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      try {
        resolve(extractResult(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export class ClaudeCliExplainer {
  constructor({ model = 'claude-opus-5', runImpl = runClaude, maxRetries = 1 } = {}) {
    this.model = model;
    this.runImpl = runImpl;
    this.maxRetries = maxRetries;
  }

  /** One call per game, covering every moment. Never throws. */
  async explain({ game, moments }) {
    if (!moments.length) return [];

    let lastError = 'no attempt made';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const prompt = attempt === 0
        ? buildUserPrompt({ game, moments })
        : buildRetryPrompt({ game, moments, error: lastError });

      let text = '';
      try {
        text = await this.runImpl({ prompt, systemPrompt: SYSTEM_PROMPT, model: this.model });
      } catch (err) {
        lastError = `claude failed: ${err.message}`;
        continue;
      }

      const parsed = parseExplanations(text);
      if (parsed.ok) return alignToMoments(parsed.data, moments);
      lastError = parsed.error;
    }

    console.warn(`[explainer] giving up after ${this.maxRetries + 1} attempts: ${lastError}`);
    return moments.map(() => null);
  }
}

/** Match explanations back to moments by ply; anything unmatched becomes null. */
function alignToMoments(explanations, moments) {
  const byPly = new Map(explanations.map((e) => [e.ply, e]));
  return moments.map((m) => byPly.get(m.ply) ?? null);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS. No real Claude call is made — every test injects `runImpl`.

- [ ] **Step 5: Verify against your subscription once, by hand**

```bash
cd server && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-unset}" && node -e "
import('./src/explainer/claudeCli.js').then(async ({ ClaudeCliExplainer }) => {
  const out = await new ClaudeCliExplainer().explain({
    game: { reviewAsColor: 'w', result: 'loss' },
    moments: [{
      ply: 8,
      fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5',
      playedMove: 'Bxf7+', evalBefore: 30, evalAfter: -280, centipawnLoss: 310, kind: 'blunder',
      engineLines: [
        { multipv: 1, move: 'd2d3', pv: ['d2d3'], cpWhite: 30 },
        { multipv: 2, move: 'f3g5', pv: ['f3g5'], cpWhite: 10 },
        { multipv: 3, move: 'b1c3', pv: ['b1c3'], cpWhite: 5 },
      ],
    }],
  });
  console.log(JSON.stringify(out, null, 2));
});
"
```

Expected: `ANTHROPIC_API_KEY=unset`, then a JSON object with `teachMove: "d3"` (or `d2d3`) and beginner-readable prose. Takes roughly 10 seconds. If the key is *not* unset, stop and unset it — otherwise the call is billed to the API rather than the subscription.

- [ ] **Step 6: Commit**

```bash
git add server/src/explainer/claudeCli.js server/test/explainer.test.js
git commit -m "feat(explainer): explain via the claude CLI on subscription auth"
```

---

### Task 9: Importer orchestration

Wire the pieces together: fetch games, evaluate every position, select moments, explain them, persist. Everything is injected, so the whole flow is testable with fakes and no engine, no network, no Claude.

**Files:**
- Create: `server/src/importer.js`
- Test: `server/test/importer.test.js`

**Interfaces:**
- Consumes: `positionsFromPgn`, `parseHeaders`, `playerColorFor` (`src/pgn.js`); `selectMoments` (`src/moments.js`); `saveGame`, `saveMoments`, `markAnalyzed`, `isAnalyzed`, `getEtag`, `setEtag` (`src/db.js`); `recentGames` (`src/chesscom.js`); an `Engine` with `analyze(fen)`; an Explainer with `explain({game, moments})`.
- Produces:
  - `analyzeGame({engine, moves, finalFen, onPosition?}) => {evals: (number|null)[], linesByPly: Line[][]}`
  - `importGame({db, engine, explainer, username, raw, onPosition?}) => {status, uuid, moments}` where `status` is `'analyzed' | 'skipped' | 'not-players-game' | 'empty'`
  - `importGames({db, engine, explainer, username, games, onProgress?}) => {analyzed, skipped, failed, total}`
  - `fetchAndImport({db, engine, explainer, username, limit?, fetchImpl?, onProgress?}) => summary`

- [ ] **Step 1: Write the failing test**

Create `server/test/importer.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/importer.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/importer.js`:

```js
import { parseHeaders, positionsFromPgn, playerColorFor } from './pgn.js';
import { selectMoments } from './moments.js';
import { saveGame, saveMoments, markAnalyzed, isAnalyzed, getEtag, setEtag } from './db.js';
import { recentGames } from './chesscom.js';

/** Evaluate every position in the game, including the final one. */
export async function analyzeGame({ engine, moves, finalFen, onPosition = () => {} }) {
  const positions = [...moves.map((m) => m.fen), finalFen];
  const evals = [];
  const linesByPly = [];

  for (let i = 0; i < positions.length; i++) {
    const { evalWhite, lines } = await engine.analyze(positions[i]);
    evals.push(evalWhite);
    linesByPly.push(lines);
    onPosition(i + 1, positions.length);
  }

  return { evals, linesByPly };
}

export async function importGame({ db, engine, explainer, username, raw, onPosition }) {
  if (isAnalyzed(db, raw.uuid)) return { status: 'skipped', uuid: raw.uuid, moments: 0 };

  const headers = parseHeaders(raw.pgn ?? '');
  const color = playerColorFor(headers, username);
  if (!color) return { status: 'not-players-game', uuid: raw.uuid, moments: 0 };

  const { moves, finalFen } = positionsFromPgn(raw.pgn);
  if (!moves.length) return { status: 'empty', uuid: raw.uuid, moments: 0 };

  const { evals, linesByPly } = await analyzeGame({ engine, moves, finalFen, onPosition });

  const selected = selectMoments({ evals, moves, playerColor: color })
    .map((m) => ({ ...m, engineLines: linesByPly[m.ply] ?? [] }));

  const side = color === 'w' ? raw.white : raw.black;
  const gameRow = {
    uuid: raw.uuid,
    username,
    url: raw.url,
    pgn: raw.pgn,
    white: raw.white?.username,
    black: raw.black?.username,
    whiteRating: raw.white?.rating,
    blackRating: raw.black?.rating,
    result: side?.result,
    timeClass: raw.time_class,
    endTime: raw.end_time,
    reviewAsColor: color,
  };

  const explanations = await explainer.explain({ game: gameRow, moments: selected });
  const enriched = selected.map((m, i) => ({
    ...m,
    teachMove: explanations[i]?.teachMove ?? null,
    explanation: explanations[i] ?? null,
  }));

  saveGame(db, gameRow);
  saveMoments(db, raw.uuid, enriched);
  markAnalyzed(db, raw.uuid);

  return { status: 'analyzed', uuid: raw.uuid, moments: enriched.length };
}

/**
 * Sequential by design: each game is written before the next starts, so a run
 * interrupted by a usage limit resumes cleanly instead of redoing work.
 */
export async function importGames({ db, engine, explainer, username, games, onProgress = () => {} }) {
  const summary = { analyzed: 0, skipped: 0, failed: 0, total: games.length };

  for (let i = 0; i < games.length; i++) {
    const raw = games[i];
    try {
      const result = await importGame({
        db, engine, explainer, username, raw,
        onPosition: (done, total) =>
          onProgress({ done: i, total: games.length, uuid: raw.uuid, phase: 'analyzing', positions: { done, total } }),
      });
      if (result.status === 'analyzed') summary.analyzed += 1;
      else summary.skipped += 1;
      onProgress({ done: i + 1, total: games.length, uuid: raw.uuid, phase: result.status, moments: result.moments });
    } catch (err) {
      summary.failed += 1;
      console.warn(`[import] ${raw.uuid} failed: ${err.message}`);
      onProgress({ done: i + 1, total: games.length, uuid: raw.uuid, phase: 'failed', error: err.message });
    }
  }

  return summary;
}

export async function fetchAndImport({
  db, engine, explainer, username, limit = 10, fetchImpl = fetch, onProgress = () => {},
}) {
  onProgress({ done: 0, total: 0, phase: 'fetching' });
  const games = await recentGames(username, {
    limit,
    fetchImpl,
    getEtag: (url) => getEtag(db, url),
    setEtag: (url, etag) => setEtag(db, url, etag),
  });
  return importGames({ db, engine, explainer, username, games, onProgress });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/importer.js server/test/importer.test.js
git commit -m "feat(import): orchestrate fetch, analysis, selection and explanation"
```

---

### Task 10: HTTP API

Four routes. `/api/import` is a **GET** rather than a POST so the browser can consume it with `EventSource`, which only speaks GET — a deliberate trade of REST purity for a much simpler client.

**Files:**
- Create: `server/src/index.js`
- Test: `server/test/api.test.js`

**Interfaces:**
- Consumes: everything from Tasks 5, 4, 8, 9.
- Produces:
  - `createApp({db, engine, explainer, username}) => express.Application`
  - `GET  /api/games` → `{games: Row[]}`
  - `GET  /api/games/:uuid` → `{game, moments}` or 404 `{error}`
  - `POST /api/evaluate` body `{fen, move, momentId?}` → `{san, fenAfter, evalWhite}` or 400 `{error: 'illegal move'}`
  - `GET  /api/import?limit=N` → `text/event-stream` emitting `progress` events then one `done` event

- [ ] **Step 1: Write the failing test**

Create `server/test/api.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/index.js`:

```js
import express from 'express';
import { openDb, listGames, getGameWithMoments, recordAttempt } from './db.js';
import { Engine, stockfishAvailable } from './engine.js';
import { ClaudeCliExplainer } from './explainer/claudeCli.js';
import { fetchAndImport } from './importer.js';

export function createApp({ db, engine, explainer, username }) {
  const app = express();
  app.use(express.json());

  app.get('/api/games', (req, res) => {
    res.json({ games: listGames(db, username) });
  });

  app.get('/api/games/:uuid', (req, res) => {
    const found = getGameWithMoments(db, req.params.uuid);
    if (!found) return res.status(404).json({ error: 'not found' });
    res.json(found);
  });

  app.post('/api/evaluate', async (req, res) => {
    const { fen, move, momentId } = req.body ?? {};
    if (!fen || !move) return res.status(400).json({ error: 'fen and move are required' });

    const result = await engine.evaluateMove(fen, move);
    if (!result) return res.status(400).json({ error: 'illegal move' });

    if (momentId != null) recordAttempt(db, momentId, result.san, result.evalWhite);
    res.json(result);
  });

  // GET, not POST, so the browser can read it with EventSource.
  app.get('/api/import', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const summary = await fetchAndImport({
        db, engine, explainer, username,
        limit: Number(req.query.limit ?? 10),
        onProgress: (p) => send('progress', p),
      });
      send('done', summary);
    } catch (err) {
      send('error', { message: err.message });
    } finally {
      res.end();
    }
  });

  return app;
}

async function start() {
  const username = process.env.CHESS_USERNAME || 'ExamplePlayer';
  const port = Number(process.env.PORT || 3000);

  if (!stockfishAvailable()) {
    console.error('Stockfish not found. Install it (brew install stockfish) or set STOCKFISH_PATH.');
    process.exit(1);
  }

  const db = openDb();
  const engine = await new Engine().start();
  const explainer = new ClaudeCliExplainer();

  createApp({ db, engine, explainer, username }).listen(port, () => {
    console.log(`chess analyzer server on http://localhost:${port} (user: ${username})`);
  });

  const shutdown = async () => { await engine.quit(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Run a real end-to-end import**

```bash
cd server && CHESS_USERNAME=ExamplePlayer node src/index.js
# in another terminal:
curl -N 'http://localhost:3000/api/import?limit=5'
curl -s http://localhost:3000/api/games | head -c 400
```

Expected: the SSE stream reports progress for up to five games and ends with a `done` event; `/api/games` then lists them with non-zero `moment_count`. This is the first time the whole pipeline runs against real data, a real engine, and real Claude — budget a few minutes.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.js server/test/api.test.js
git commit -m "feat(api): games, evaluate and streaming import endpoints"
```

---

### Task 11: Web shell and game list

The first screen: import games, then pick one to review.

The frontend has no automated tests. That is a deliberate scope decision for a single-user local tool — all the logic worth testing lives on the server, and the UI is thin enough that manual verification is honest rather than lazy. Each step below therefore states exactly what to look at and what should be true.

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.js`
- Create: `web/index.html`
- Create: `web/src/main.jsx`
- Create: `web/src/api.js`
- Create: `web/src/App.jsx`
- Create: `web/src/GameList.jsx`

**Interfaces:**
- Consumes: the HTTP API from Task 10.
- Produces:
  - `api.js`: `getGames()`, `getGame(uuid)`, `evaluate({fen, move, momentId})`, `startImport({limit, onProgress, onDone, onError}) => EventSource`
  - `<App />` — holds the selected game uuid and swaps between list and review
  - `<GameList onSelect={(uuid) => void} />`

- [ ] **Step 1: Create the web package**

Create `web/package.json`:

```json
{
  "name": "chess-analyzer-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "chess.js": "^1.4.0",
    "react": "^19.1.0",
    "react-chessboard": "^4.7.3",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.4.0",
    "vite": "^6.3.0"
  }
}
```

`react-chessboard` is pinned to the v4 line — v5 changed to a single `options` prop and the JSX below would not work against it.

- [ ] **Step 2: Install and configure Vite**

Run: `cd web && npm install`

Create `web/vite.config.js`:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
```

Create `web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chess Review</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex; justify-content: center;
      }
      main { width: min(560px, 94vw); padding: 24px 0 64px; }
      button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
      table { width: 100%; border-collapse: collapse; }
      td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid #8883; }
      tr[data-clickable] { cursor: pointer; }
      tr[data-clickable]:hover { background: #8881; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

Create `web/src/main.jsx`:

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Write the API client**

Create `web/src/api.js`:

```js
async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

export async function getGames() {
  return json(await fetch('/api/games'));
}

export async function getGame(uuid) {
  return json(await fetch(`/api/games/${encodeURIComponent(uuid)}`));
}

export async function evaluate({ fen, move, momentId }) {
  return json(await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen, move, momentId }),
  }));
}

/** Server-sent events; the caller closes the returned EventSource. */
export function startImport({ limit = 10, onProgress, onDone, onError }) {
  const source = new EventSource(`/api/import?limit=${limit}`);
  source.addEventListener('progress', (e) => onProgress?.(JSON.parse(e.data)));
  source.addEventListener('done', (e) => { onDone?.(JSON.parse(e.data)); source.close(); });
  source.addEventListener('error', (e) => {
    onError?.(e.data ? JSON.parse(e.data) : { message: 'connection lost' });
    source.close();
  });
  return source;
}
```

- [ ] **Step 4: Write the shell and the game list**

Create `web/src/App.jsx`:

```jsx
import { useState, useEffect } from 'react';
import GameList from './GameList.jsx';
import Review from './Review.jsx';
import { getGame } from './api.js';

export default function App() {
  const [selected, setSelected] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!selected) { setLoaded(null); return; }
    let cancelled = false;
    getGame(selected)
      .then((data) => { if (!cancelled) setLoaded(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selected]);

  if (error) {
    return <main><p>{error}</p><button onClick={() => { setError(null); setSelected(null); }}>Back</button></main>;
  }
  if (!selected) return <main><GameList onSelect={setSelected} /></main>;
  if (!loaded) return <main><p>Loading game…</p></main>;

  return (
    <main>
      <Review game={loaded.game} moments={loaded.moments} onBack={() => setSelected(null)} />
    </main>
  );
}
```

Create `web/src/GameList.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { getGames, startImport } from './api.js';

const when = (endTime) =>
  endTime ? new Date(endTime * 1000).toLocaleDateString() : '';

export default function GameList({ onSelect }) {
  const [games, setGames] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => getGames().then((d) => setGames(d.games)).catch((e) => setError(e.message));

  useEffect(() => { refresh(); }, []);

  function runImport() {
    setError(null);
    setStatus('Fetching games…');
    startImport({
      limit: 10,
      onProgress: (p) => setStatus(
        p.phase === 'analyzing'
          ? `Analyzing game ${p.done + 1}/${p.total} — position ${p.positions.done}/${p.positions.total}`
          : `Game ${p.done}/${p.total}: ${p.phase}`,
      ),
      onDone: (s) => {
        setStatus(`Done — ${s.analyzed} analyzed, ${s.skipped} already done, ${s.failed} failed.`);
        refresh();
      },
      onError: (e) => { setError(e.message); setStatus(null); },
    });
  }

  return (
    <>
      <h1>Your games</h1>
      <p>
        <button onClick={runImport}>Import latest games</button>
      </p>
      {status && <p>{status}</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {games.length === 0 && !status && <p>No games yet. Hit import.</p>}

      <table>
        <thead>
          <tr><th>Date</th><th>Opponent</th><th>Result</th><th>Type</th><th>Mistakes</th></tr>
        </thead>
        <tbody>
          {games.map((g) => {
            const iAmWhite = g.review_as_color === 'w';
            return (
              <tr key={g.uuid} data-clickable onClick={() => onSelect(g.uuid)}>
                <td>{when(g.end_time)}</td>
                <td>{iAmWhite ? g.black : g.white}</td>
                <td>{g.result}</td>
                <td>{g.time_class}</td>
                <td>{g.moment_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 5: Verify manually**

Run, in two terminals:

```bash
cd server && node src/index.js
cd web && npm run dev
```

Open `http://localhost:5173`. Expected, in order:
1. The page shows "Your games" and either an empty state or previously imported games.
2. Clicking **Import latest games** shows a status line that advances through positions and games.
3. When it finishes, the table lists your games with an opponent, a result, and a non-zero mistake count for at least one game.
4. Clicking a row shows "Loading game…" and then fails with a missing-module error for `Review.jsx` — that is expected; Task 12 supplies it.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.js web/index.html web/src/main.jsx web/src/api.js web/src/App.jsx web/src/GameList.jsx
git commit -m "feat(web): app shell, api client and game list"
```

---

### Task 12: Review board and quiz flow

The screen the whole tool exists for. Board, one line of text, two buttons.

**Files:**
- Create: `web/src/Review.jsx`

**Interfaces:**
- Consumes: `evaluate` from `./api.js`; `game` and `moments` as returned by `GET /api/games/:uuid`.
- Produces: `<Review game={game} moments={moments} onBack={fn} />`

Note the field names coming from the API are the SQLite column names: `review_as_color`, `played_move`, `teach_move`, `centipawn_loss`, plus the camelCase `engineLines` and `explanation` that `getGameWithMoments` parses out of JSON.

- [ ] **Step 1: Write the component**

Create `web/src/Review.jsx`:

```jsx
import { useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { evaluate } from './api.js';

/** Convert a SAN move into its from/to squares so we can draw an arrow. */
function sanToSquares(fen, san) {
  try {
    const board = new Chess(fen);
    const move = board.move(san);
    return move ? [move.from, move.to] : null;
  } catch {
    return null;
  }
}

const RED = 'rgb(200, 60, 60)';
const GREEN = 'rgb(45, 155, 85)';

export default function Review({ game, moments, onBack }) {
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [note, setNote] = useState(null);

  const moment = moments[index];

  // Evaluations are stored from White's view; show them from the player's.
  const sign = game.review_as_color === 'w' ? 1 : -1;
  const asPawns = (cp) => {
    if (cp == null) return '?';
    const v = (sign * cp) / 100;
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  };

  const playedSquares = useMemo(
    () => (moment ? sanToSquares(moment.fen, moment.played_move) : null),
    [moment],
  );

  const teachSquares = useMemo(() => {
    const t = moment?.teach_move;
    if (!t || t.length < 4) return null;
    return [t.slice(0, 2), t.slice(2, 4)];
  }, [moment]);

  const arrows = revealed
    ? [
        playedSquares && [...playedSquares, RED],
        teachSquares && [...teachSquares, GREEN],
      ].filter(Boolean)
    : [];

  function goTo(next) {
    setIndex(next);
    setAttempt(null);
    setRevealed(false);
    setNote(null);
  }

  async function onDrop(from, to, piece) {
    if (revealed) return false;

    // Beginners will rarely under-promote; assume a queen.
    const isPawn = piece?.[1]?.toLowerCase() === 'p';
    const lastRank = to[1] === '8' || to[1] === '1';
    const uci = from + to + (isPawn && lastRank ? 'q' : '');

    try {
      const result = await evaluate({ fen: moment.fen, move: uci, momentId: moment.id });
      setAttempt(result);
      setRevealed(true);
      setNote(null);
    } catch {
      setNote('That move is not legal here — try another.');
    }
    return false; // keep the puzzle position on the board
  }

  if (!moment) {
    return (
      <>
        <button onClick={onBack}>← All games</button>
        <h2>Nothing to review</h2>
        <p>No clear mistakes were found in this game.</p>
      </>
    );
  }

  const moveNumber = Math.floor(moment.ply / 2) + 1;
  const explanation = moment.explanation;

  return (
    <>
      <button onClick={onBack}>← All games</button>

      <h2>
        Move {moveNumber}
        {moment.kind === 'missed_win' ? ' — you had a chance here' : ''}
      </h2>

      <Chessboard
        position={moment.fen}
        onPieceDrop={onDrop}
        boardOrientation={game.review_as_color === 'w' ? 'white' : 'black'}
        customArrows={arrows}
        arePiecesDraggable={!revealed}
        boardWidth={Math.min(520, Math.floor(window.innerWidth * 0.9))}
      />

      {!revealed && (
        <>
          <p>
            {moment.kind === 'missed_win'
              ? 'Your opponent just made a mistake. Can you punish it?'
              : 'You went wrong here. What would you play?'}
          </p>
          {note && <p style={{ color: 'crimson' }}>{note}</p>}
          <button onClick={() => setRevealed(true)}>Just show me</button>
        </>
      )}

      {revealed && (
        <div>
          <table>
            <tbody>
              <tr>
                <td>You played</td>
                <td><strong>{moment.played_move}</strong></td>
                <td>{asPawns(moment.eval_after)}</td>
              </tr>
              {moment.teach_move && (
                <tr>
                  <td>Better was</td>
                  <td><strong>{moment.teach_move}</strong></td>
                  <td>{asPawns(moment.eval_before)}</td>
                </tr>
              )}
              {attempt && (
                <tr>
                  <td>Your try</td>
                  <td><strong>{attempt.san}</strong></td>
                  <td>{asPawns(attempt.evalWhite)}</td>
                </tr>
              )}
            </tbody>
          </table>

          {explanation ? (
            <>
              <p>{explanation.whatWentWrong}</p>
              <p>{explanation.whyBetter}</p>
              <p><em>{explanation.pattern}</em></p>
            </>
          ) : (
            <p><em>No written explanation for this one — compare the two moves on the board.</em></p>
          )}
        </div>
      )}

      <p>
        <button disabled={index === 0} onClick={() => goTo(index - 1)}>← Previous</button>
        {' '}
        <span>{index + 1} of {moments.length}</span>
        {' '}
        <button disabled={index === moments.length - 1} onClick={() => goTo(index + 1)}>Next →</button>
      </p>
    </>
  );
}
```

- [ ] **Step 2: Verify manually**

With both servers running, open `http://localhost:5173` and click into a game. Check each of these:

1. The board is oriented from your side — if you were Black, Black's pieces are at the bottom.
2. The prompt reads "You went wrong here. What would you play?" and no arrows are shown.
3. Dragging an **illegal** move snaps back and shows "That move is not legal here".
4. Dragging a **legal** move reveals the panel: a red arrow for what you played, a green arrow for the better move, the three-row table, and the explanation prose.
5. The evaluations read from your point of view — if you were Black and the move was bad for you, the number is negative.
6. **Previous** is disabled on the first moment, **Next** on the last, and moving between moments clears the previous reveal.
7. A moment tagged `missed_win` reads "you had a chance here" instead.

- [ ] **Step 3: Confirm attempts are being recorded**

```bash
cd server && node -e "
import('./src/db.js').then(({ openDb }) => {
  const db = openDb();
  console.log(db.prepare('SELECT a.move, a.eval, m.ply, m.played_move FROM attempts a JOIN moments m ON m.id = a.moment_id ORDER BY a.id DESC LIMIT 10').all());
});
"
```

Expected: one row per guess you made, newest first. This table is what a later "which mistakes do I repeat?" feature reads.

- [ ] **Step 4: Commit**

```bash
git add web/src/Review.jsx
git commit -m "feat(web): review board with quiz-then-reveal flow"
```

---

## Done

At this point the tool is complete against the spec: import your chess.com games, have them analyzed and explained once, and review them by being quizzed on the five moments that decided each one, with every guess recorded.

Deliberately not built, and why:
- **Live game assistance** — prohibited by chess.com fair play, and would risk the account.
- **Frontend tests** — the logic lives on the server; the UI is thin and manually verified.
- **Rule-based explanation fallback** — the `Explainer` interface exists so this can be added as one file if the CLI's usage-window cost becomes annoying.
- **Cross-game pattern analysis** ("you keep hanging knights") — the `attempts` and `moments` tables hold everything it needs, but it wants more than five games of history to be meaningful.
