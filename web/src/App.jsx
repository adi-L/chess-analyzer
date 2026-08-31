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
