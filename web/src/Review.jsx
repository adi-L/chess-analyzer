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

/** Convert a UCI move (as stored in teach_move) into a played chess.js Move, for display and arrows. */
function uciToMove(fen, uci) {
  if (!uci) return null;
  try {
    const board = new Chess(fen);
    return board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4) || undefined,
    });
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
    const view = sign * cp;
    if (Math.abs(cp) > 90000) {
      const pliesToMate = 100000 - Math.abs(cp);
      const movesToMate = Math.ceil(pliesToMate / 2);
      return view >= 0 ? `mate in ${movesToMate}` : `mate against you in ${movesToMate}`;
    }
    const v = view / 100;
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  };

  const playedSquares = useMemo(
    () => (moment ? sanToSquares(moment.fen, moment.played_move) : null),
    [moment],
  );

  // teach_move is UCI in the database; parse it once for both the arrow and
  // the human-readable label. Falls back to the raw string if it can't be
  // parsed against the moment's FEN.
  const teachMove = useMemo(
    () => (moment ? uciToMove(moment.fen, moment.teach_move) : null),
    [moment],
  );
  const teachMoveLabel = moment?.teach_move ? (teachMove?.san ?? moment.teach_move) : null;
  const teachSquares = teachMove ? [teachMove.from, teachMove.to] : null;

  // The eval belongs to the teaching move specifically, not necessarily to
  // MultiPV line 1 (eval_before), since the teaching move is often not the
  // engine's top choice.
  const teachEval =
    moment?.engineLines?.find((l) => l.move === moment.teach_move)?.cpWhite ?? moment?.eval_before;

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

  function onDrop(from, to, piece) {
    if (revealed) return false;

    // Beginners will rarely under-promote; assume a queen.
    const isPawn = piece?.[1]?.toLowerCase() === 'p';
    const lastRank = to[1] === '8' || to[1] === '1';
    const uci = from + to + (isPawn && lastRank ? 'q' : '');

    // Deliberately not awaited: react-chessboard needs a synchronous boolean
    // back, and an async handler returns a promise, which it reads as truthy
    // and lets the piece move off the puzzle position.
    evaluate({ fen: moment.fen, move: uci, momentId: moment.id })
      .then((result) => {
        setAttempt(result);
        setRevealed(true);
        setNote(null);
      })
      .catch(() => setNote('That move is not legal here — try another.'));

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
                  <td><strong>{teachMoveLabel}</strong></td>
                  <td>{asPawns(teachEval)}</td>
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
