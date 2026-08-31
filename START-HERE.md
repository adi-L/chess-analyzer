# Chess Analyzer — resume here

Personal tool: replays a chess.com game, stops at the 5 moments that decided it,
quizzes you on what to play, explains the answer for a beginner.

## Status
Design + implementation plan are done and committed. **No code written yet.**
Next step is Task 1 of the plan.

## Read these
- Plan (what to build, 12 TDD tasks): `docs/superpowers/plans/2026-08-31-chess-analyzer.md`
- Spec (why it's built that way):    `docs/superpowers/specs/2026-08-31-chess-analyzer-design.md`

## Before starting
    brew install stockfish          # required by Task 4 onward
    echo ${ANTHROPIC_API_KEY:-unset}  # must print "unset"

## Key facts
- Explanations run through the `claude` CLI on the Claude subscription.
  There is NO Anthropic API key and NO Anthropic npm package. Keep it that way.
- chess.com username: Crazy_Harp (rating ~229 rapid, 5 games as of 2026-08-31).
- Tasks 1-3 are pure functions — testable with no engine, no network, no Claude.
