/**
 * chess.com blocks anonymous clients and asks for contact info in the
 * User-Agent, so it must carry something they can reach you at. It is read
 * from the environment rather than hardcoded, to keep a personal email out of
 * the source. Set CHESS_CONTACT to your own email before importing.
 */
export function buildUserAgent(contact) {
  return `chess-analyzer/0.1 (${contact || 'contact-not-set'})`;
}

export const USER_AGENT = buildUserAgent(process.env.CHESS_CONTACT);
const BASE = 'https://api.chess.com/pub';

function headerOf(res, name) {
  // Works with both a real Headers object and a Map in tests.
  if (typeof res.headers?.get === 'function') return res.headers.get(name) ?? null;
  return null;
}

export async function listArchives(username, { fetchImpl = fetch } = {}) {
  const url = `${BASE}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`chess.com archives request failed: ${res.status}`);
  const body = await res.json();
  return body.archives ?? [];
}

export async function fetchMonth(url, { etag = null, fetchImpl = fetch } = {}) {
  const headers = { 'User-Agent': USER_AGENT };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetchImpl(url, { headers });
  if (res.status === 304) return { notModified: true, games: [], etag };
  if (!res.ok) throw new Error(`chess.com month request failed: ${res.status} (${url})`);

  const body = await res.json();
  return { notModified: false, games: body.games ?? [], etag: headerOf(res, 'etag') };
}

/**
 * Newest games first. Archives are walked backwards and requested one at a
 * time — chess.com returns 429 for concurrent requests from one IP.
 */
export async function recentGames(username, {
  limit = 10,
  fetchImpl = fetch,
  getEtag = () => null,
  setEtag = () => {},
} = {}) {
  // A zero (or negative) limit has nothing to fetch. Returning before the
  // archives request keeps callers that pass limit=0 off the network entirely.
  if (limit <= 0) return [];

  const archives = await listArchives(username, { fetchImpl });
  const collected = [];
  const pendingETags = [];

  for (let i = archives.length - 1; i >= 0 && collected.length < limit; i--) {
    const url = archives[i];
    const { notModified, games, etag } = await fetchMonth(url, { etag: getEtag(url), fetchImpl });
    const sorted = [...games].sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0));
    collected.push(...sorted);
    if (!notModified) {
      pendingETags.push({ url, etag, upTo: collected.length });
    }
  }

  const returned = collected.slice(0, limit);
  for (const { url, etag, upTo } of pendingETags) {
    if (upTo <= returned.length) {
      setEtag(url, etag);
    }
  }

  return returned;
}
