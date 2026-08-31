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
