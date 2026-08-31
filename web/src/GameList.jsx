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
