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
