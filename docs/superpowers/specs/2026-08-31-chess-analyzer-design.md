# Chess Analyzer — Design

**Date:** 2026-08-31
**Status:** Approved design, pending implementation plan
**Owner:** Adi Levi (chess.com: `ExamplePlayer`)

## Purpose

A personal tool that replays a chess.com game, stops at the moments where the
game was actually decided, asks what should have been played, and then explains
the answer in plain language.

The goal is not to view games. It is to build the habit of seeing the mistake
before making it. Every design decision below is subordinate to that.

## Context

- One user. No accounts, no multi-tenancy, no hosting. Runs on localhost.
- Player rating: **229 rapid**, account created 2026-08-24, 5 games played.
  This is an absolute beginner, and the design targets that explicitly.
- Chess.com's Published-Data API is public and unauthenticated. "My games" is
  a username in a URL, not an access boundary.

## Non-goals

- Live assistance during a game. Chess.com's fair-play rules prohibit engine
  help in an ongoing game, and building it would risk a ban. Post-game only.
- Multi-user support, deployment, or public distribution.
- An eval graph, opening explorer, or move-list UI. Deliberately excluded —
  the value is in stopping at five moments, not in more numbers to scroll past.

## Architecture

Local Node server + React frontend. Stockfish runs as a native binary owned by
the server, not as WASM in the browser.

    chess.com API ──▶ parse PGN ──▶ Stockfish ──▶ rank + select ──▶ Claude ──▶ SQLite
       (fetch)        (chess.js)     (UCI)        (worst 5)      (explain)   (cache)

Rationale for engine-on-server:
- Native Stockfish is roughly 5-10x faster than the WASM build. A full game
  analyzes in ~2s rather than ~20s.
- One long-lived UCI process serves both batch import and live quiz answers.
- Nothing is distributed to a browser, so Stockfish's GPL v3 obligations are
  not triggered (GPL binds on distribution; local personal use is unrestricted).
- Chess.com's API sends no CORS headers, so a browser-only build would need a
  proxy server regardless. Given a server exists, it should own the engine.

## Pipeline (per game, on import)

1. **Fetch** — `GET /pub/player/{username}/games/{YYYY}/{MM}`. Serial requests
   only (parallel requests get 429). Send a descriptive User-Agent with contact
   info; anonymous clients are blocked. Store `ETag` per archive and send
   `If-None-Match` on re-sync — past months never change.
2. **Replay** — `chess.js` walks the PGN, producing a FEN per ply. The PGN also
   carries `[%clk ...]` per move, giving time-per-move for free.
3. **Evaluate** — each position to Stockfish at depth 14, **MultiPV 3**. Depth 14
   is ample for beginner-scale errors and keeps a 40-move game near 2 seconds.
4. **Rank and select** — score each of the player's moves by centipawn loss
   (eval before vs. after, from the player's perspective). Take the **five
   largest**, discarding any below a **100cp floor** so nothing trivial is
   surfaced. Skip positions where the player was already losing by more than
   **600cp** before moving — once a queen down, every move "loses" more and
   there is nothing left to learn.

   Ranking rather than a fixed threshold is deliberate: at 229 a fixed 200cp
   threshold flags nearly every move. Ranking surfaces the five worst at any
   rating and needs no retuning as the player improves.

5. **Select the teaching move** — Stockfish's top choice is often a quiet
   positional move a beginner could never find. The three MultiPV lines and
   their evaluations are handed to Claude, which picks the move that is both
   good and *findable*, and explains that one. A free knight at +0.1 beats a
   subtle rook lift at +0.3 as a lesson.
6. **Explain** — one Claude call per game covering all five moments, returning
   a JSON array.
7. **Cache** — everything to SQLite keyed by the game's `uuid`. Never recomputed.

## Two kinds of teaching moment

- `blunder` — the player's own move lost significant ground.
- `missed_win` — the *opponent* blundered and the player did not punish it.
  Detected as: opponent's move drops their own eval sharply, and the player's
  reply fails to capitalize.

The second kind is the one standard review tools bury, and at beginner level it
often accounts for half the swing in a game. "They left their queen hanging on
move 14" is a durable lesson.

## Review UX

Two screens.

**Game list** — import button; games showing opponent, result, time control,
and a count of teaching moments.

**Review board** — board, one line of text, two buttons. No eval graph, no
engine lines, no move list. Board always oriented from the side being reviewed.

Flow at each moment:

1. Board auto-plays to the position and stops.
2. "You went wrong here. What would you play?"
3. The player drags a move on the board.
4. The server evaluates that specific move live, then reveals: the move played
   in the game with its eval, the teaching move with its eval, the player's
   attempt with its eval, and the explanation. Red and green arrows on the board.

Quiz-then-reveal is the core mechanic: active recall is what builds recognition.
It is also why the engine must be callable at request time, not merely
precomputed — the player's attempted move is not known in advance.

## Explanation layer

Generated via the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), which
resolves the same credentials as the `claude` CLI and therefore runs on the
user's Claude subscription rather than API billing.

Accepted trade-offs, decided by the user with the caveats stated:
- Heavier than a direct API call (spawns the Claude Code harness).
- Consumes the same 5-hour usage window as the user's coding work. At five
  games this is negligible; it would matter at 40+.
- Subscription auth is intended for Claude Code; using it for a self-built app
  is a grey area. Acceptable for a local personal tool; the app must not be
  distributed.

Configuration — the harness is stripped to nothing:

    model: "claude-opus-5"
    systemPrompt: CHESS_COACH_PROMPT   // plain string, NOT the claude_code preset
    settingSources: []                 // do not load user/project CLAUDE.md
    disallowedTools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task]
    maxTurns: 1                        // single shot, no agent loop

`settingSources: []` is load-bearing: without it the user's global CLAUDE.md
would be injected into every chess prompt. Bare tool names in `disallowedTools`
remove tools from context entirely rather than merely denying calls.

`startup()` pre-warms the CLI subprocess before a batch import.

**Structured output.** The Agent SDK does not expose the API's
`output_config.format`, so parseable JSON is not guaranteed. Mitigation: request
a fenced JSON block, validate against a Zod schema on receipt, retry once on
parse failure, store raw text on a second failure.

**Explanation register.** Target an absolute beginner. The prompt must not
assume "defended", "fork", "development", or "initiative" carry meaning. Correct
register: "Your knight on f6 can be taken by the bishop, and you have nothing
that can take back."

**Batching.** One call per game covering all moments — one subprocess spawn per
game rather than one per moment.

**Resumability.** Import processes games sequentially, writing each result to
SQLite as it completes. If a usage limit is hit mid-import it stops cleanly and
resumes later. Nothing is recomputed.

**Boundary.** A single `Explainer` interface, `explain(moments) => Explanation[]`.
`AgentSdkExplainer` is the only implementation built; `FakeExplainer` backs the
tests. Swapping to the API or to rule-based templates later is a new file, not
a refactor.

## Data model (SQLite)

- **games** — `uuid` (PK, from chess.com), `username`, `pgn`, opponent, ratings,
  result, `time_class`, `end_time`, `review_as_color`, `analyzed_at`
- **moments** — `game_uuid` (FK), `ply`, `fen`, `played_move`, `eval_before`,
  `eval_after`, `centipawn_loss`, `engine_lines` (MultiPV JSON), `teach_move`,
  `explanation` (JSON), `kind` (`blunder` | `missed_win`)
- **attempts** — `moment_id` (FK), `move`, `eval`, `created_at`

`attempts` is what makes this a teaching tool rather than a viewer: every guess
is recorded, so a game replayed weeks later shows whether the same pattern is
now recognised. It is also the substrate for later "which mistakes do I repeat?"
analysis.

`username` and `review_as_color` are stored per game so the same flow works on
another player's game — useful now, since five games is little material, and
studying a strong player's wins teaches plans that studying one's own losses
does not.

## API surface

- `POST /api/import` — fetch + analyze, SSE progress, resumable
- `GET  /api/games` — list
- `GET  /api/games/:uuid` — game plus its moments
- `POST /api/evaluate` — `{ fen, move }` -> eval, for quiz answers

## Stack

| Layer | Choice |
|---|---|
| Engine | Stockfish native binary (`brew install stockfish`), UCI over stdio |
| Server | Node 24 + Express + `better-sqlite3` |
| Chess logic | `chess.js` |
| LLM | `@anthropic-ai/claude-agent-sdk` |
| Validation | `zod` |
| Frontend | Vite + React + `react-chessboard` |

## Testing

The three pieces carrying real logic are pure functions, testable with no engine
and no network:

- **UCI parser** — recorded Stockfish output to structured evals.
- **Moment selector** — an array of evals to the chosen plies, covering both
  `blunder` and `missed_win`, the 600cp already-lost skip, the 100cp floor,
  and the five-moment cap (including the case where fewer than five qualify).
- **Teaching-move selector** — given MultiPV lines, pick and justify.

The Stockfish process and the Agent SDK sit behind thin wrappers so both can be
faked in tests.

## Configuration

- `CHESS_USERNAME` — defaults to `ExamplePlayer`
- `STOCKFISH_PATH` — defaults to the Homebrew location
- Note: exporting `ANTHROPIC_API_KEY` silently switches the Agent SDK from
  subscription to API billing. Currently unset, which is what we want.

## Open questions

- `model` is set to `claude-opus-5`. `claude-sonnet-5` would be more than
  adequate for this task and would leave far more subscription headroom for
  coding work. User's call; not changed without instruction.
