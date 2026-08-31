# chess-analyzer

A local tool that replays one of your chess.com games, stops at the five
moments that actually decided it, asks what you would have played, and then
explains the answer in plain language.

The goal isn't to review games. It's to build the habit of seeing the mistake
before you make it — so the quiz comes first and the answer comes second.

## How it works

    chess.com API ─▶ parse PGN ─▶ Stockfish ─▶ rank + select ─▶ Claude ─▶ SQLite
       (fetch)       (chess.js)     (UCI)       (worst 5)      (explain)  (cache)

Stockfish runs as a native binary owned by the server, not as WASM in the
browser — roughly 5-10x faster, and one long-lived UCI process serves both
batch import and the live evaluation of whatever move you drag on the board.

Two kinds of moment are surfaced:

- **blunder** — your own move lost significant ground.
- **missed_win** — your *opponent* blundered and you didn't punish it. Standard
  review tools bury these, and at beginner level they're often half the swing.

Moves are ranked by centipawn loss rather than filtered by a fixed threshold,
so the same code surfaces the five worst mistakes at any rating without
retuning. Positions where you were already losing by more than 600cp are
skipped — once you're a queen down, every move "loses" more and there's
nothing left to learn.

Explanations are written for a genuine beginner. The prompt forbids leaning on
jargon, so you get *"Your knight on f6 can be taken by the bishop on g5, and
you have nothing that can take back"* rather than *"this weakens your kingside
structure."*

Every guess you make is recorded, which is what makes this a teaching tool
rather than a viewer — replay a game weeks later and you can see whether the
pattern is now recognised.

## Requirements

- Node 24+ (uses built-in `node:sqlite` and `node:test`)
- Stockfish — `brew install stockfish`
- The [Claude Code](https://claude.com/claude-code) CLI, already signed in.
  Explanations spawn `claude` and run on your existing subscription; there is
  no API key anywhere, and the server actively strips `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` from the subprocess environment so an exported key
  can't silently redirect billing to the paid API.

## Running it

Two processes, two shells:

    cd server && CHESS_USERNAME=your_handle CHESS_CONTACT=you@example.com npm start
    cd web    && npm run dev

Then open the URL Vite prints. Hit **Import latest games**, wait for the
progress stream, and click a game.

If port 3000 is taken, set `PORT` in **both** shells — the server and the Vite
proxy each default to 3000 independently.

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `CHESS_USERNAME` | `ExamplePlayer` | Whose games to import |
| `CHESS_CONTACT` | `contact-not-set` | Goes into the `User-Agent`; chess.com blocks anonymous clients |
| `PORT` | `3000` | API port (set it for the web dev server too) |
| `STOCKFISH_PATH` | `stockfish` | Path to the engine binary |
| `CHESS_DB` | `chess.db` | SQLite cache location |

## Tests

    cd server && npm test

90 tests, no test framework — just `node --test`. The three modules carrying
real logic (UCI parsing, moment selection, PGN replay) are pure functions and
are tested without an engine or a network. The engine, database, chess.com
client, and explainer all sit behind thin adapters that are faked at their
boundary.

`web/` has no automated tests. That's a deliberate scope decision for a
single-user local tool: the logic worth testing lives on the server, and the UI
is thin enough that manual verification is honest rather than lazy.

## Not built, on purpose

- **Live assistance during a game.** Chess.com's fair-play rules prohibit
  engine help in an ongoing game. Post-game only, always.
- **An eval graph, opening explorer, or move list.** The value is in stopping
  at five moments, not in more numbers to scroll past.
- **Multi-user support or hosting.** It runs on localhost, for one person.

## Design notes

`docs/superpowers/specs/` has the design and the reasoning behind each
decision; `docs/superpowers/plans/` has the implementation plan it was built
from.
