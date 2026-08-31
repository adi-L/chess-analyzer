# Chess Analyzer — resume here

Personal tool: replays a chess.com game, stops at the 5 moments that decided it,
quizzes you on what to play, explains the answer for a beginner.

## Status
Built and working. All 12 plan tasks done, whole-branch review passed,
86+ tests green. `server/chess.db` already holds 5 analyzed games with 24
scored moments — open the app and there's something to review immediately.

## Run it
Two processes, two shells. **Set `PORT` in both** — `server/src/index.js` and
`web/vite.config.js` each default to 3000 independently, and on this machine
port 3000 is already taken by an unrelated project. Use something else, e.g.:

    # shell 1
    cd server && PORT=4123 CHESS_CONTACT=you@example.com npm start

    # shell 2
    cd web && PORT=4123 npm run dev

Then open the URL Vite prints (usually `http://localhost:5173`).

## Tests
    cd server && npm test

`web/` has no tests by design (recorded scope decision — don't add a test
framework there).

## Read these
- Plan (what to build, 12 TDD tasks): `docs/superpowers/plans/2026-08-31-chess-analyzer.md`
- Spec (why it's built that way):    `docs/superpowers/specs/2026-08-31-chess-analyzer-design.md`

## Key facts
- Explanations run through the `claude` CLI on the Claude subscription —
  there is NO Anthropic API key and NO Anthropic npm package, and the server
  strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the environment
  before spawning it (`server/src/explainer/claudeCli.js`, `sanitizedEnv`) so
  a key exported in the wrong shell can't silently redirect billing. Keep it
  that way.
- `server/chess.db` is the cache of chess.com games + Stockfish analysis.
  Delete it to force a re-fetch/re-analyze; otherwise it just grows.
- chess.com username: ExamplePlayer (rating ~229 rapid). Override with
  `CHESS_USERNAME`.
- `CHESS_CONTACT` is the email that goes into the `User-Agent` chess.com
  requires — they block anonymous clients. It is read from the environment
  rather than hardcoded so a personal address stays out of this public repo;
  without it, requests go out as `contact-not-set`, which chess.com may
  eventually refuse. Set it in the shell that runs the server.
- Stockfish must be installed (`brew install stockfish`) for anything past
  the pure-function tasks.
