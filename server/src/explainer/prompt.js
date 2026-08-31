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
