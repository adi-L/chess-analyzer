import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listArchives, fetchMonth, recentGames, USER_AGENT } from '../src/chesscom.js';

function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, headers: init.headers ?? {} });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    return {
      ok: route.status < 400,
      status: route.status,
      headers: new Map(Object.entries(route.headers ?? {})),
      json: async () => route.body,
    };
  };
}

const ARCHIVES_URL = 'https://api.chess.com/pub/player/crazy_harp/games/archives';

test('listArchives returns the archive urls and sends the User-Agent', async () => {
  const log = [];
  const fetchImpl = fakeFetch({
    [ARCHIVES_URL]: { status: 200, body: { archives: ['u/2026/07', 'u/2026/08'] } },
  }, log);

  const got = await listArchives('crazy_harp', { fetchImpl });
  assert.deepEqual(got, ['u/2026/07', 'u/2026/08']);
  assert.equal(log[0].headers['User-Agent'], USER_AGENT);
});

test('fetchMonth returns games and the etag', async () => {
  const fetchImpl = fakeFetch({
    'u/2026/08': { status: 200, headers: { etag: 'W/"x"' }, body: { games: [{ uuid: '1' }] } },
  });
  const got = await fetchMonth('u/2026/08', { fetchImpl });
  assert.equal(got.notModified, false);
  assert.equal(got.etag, 'W/"x"');
  assert.deepEqual(got.games, [{ uuid: '1' }]);
});

test('fetchMonth sends If-None-Match and reports 304 as notModified', async () => {
  const log = [];
  const fetchImpl = fakeFetch({ 'u/2026/07': { status: 304, body: {} } }, log);
  const got = await fetchMonth('u/2026/07', { etag: 'W/"old"', fetchImpl });
  assert.equal(got.notModified, true);
  assert.deepEqual(got.games, []);
  assert.equal(log[0].headers['If-None-Match'], 'W/"old"');
});

test('recentGames walks archives newest-first and stops at the limit', async () => {
  const log = [];
  const fetchImpl = fakeFetch({
    [ARCHIVES_URL]: { status: 200, body: { archives: ['u/2026/06', 'u/2026/07', 'u/2026/08'] } },
    'u/2026/08': { status: 200, body: { games: [{ uuid: 'g3', end_time: 30 }, { uuid: 'g2', end_time: 20 }] } },
    'u/2026/07': { status: 200, body: { games: [{ uuid: 'g1', end_time: 10 }] } },
    'u/2026/06': { status: 200, body: { games: [{ uuid: 'g0', end_time: 5 }] } },
  }, log);

  const got = await recentGames('crazy_harp', { limit: 3, fetchImpl });
  assert.deepEqual(got.map((g) => g.uuid), ['g3', 'g2', 'g1']);
  // June must never be requested — the limit was reached in July.
  assert.equal(log.some((e) => e.url === 'u/2026/06'), false);
});

test('recentGames issues requests strictly one at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const body = url.endsWith('archives')
      ? { archives: ['u/2026/07', 'u/2026/08'] }
      : { games: [{ uuid: url, end_time: 1 }] };
    return { ok: true, status: 200, headers: new Map(), json: async () => body };
  };

  await recentGames('crazy_harp', { limit: 10, fetchImpl });
  assert.equal(maxInFlight, 1, 'parallel requests to chess.com return 429');
});

test('recentGames uses the etag store when one is supplied', async () => {
  const store = new Map([['u/2026/08', 'W/"cached"']]);
  const log = [];
  const fetchImpl = fakeFetch({
    [ARCHIVES_URL]: { status: 200, body: { archives: ['u/2026/08'] } },
    'u/2026/08': { status: 304, body: {} },
  }, log);

  const got = await recentGames('crazy_harp', {
    limit: 5,
    fetchImpl,
    getEtag: (url) => store.get(url) ?? null,
    setEtag: (url, etag) => store.set(url, etag),
  });
  assert.deepEqual(got, []);
  assert.equal(log[1].headers['If-None-Match'], 'W/"cached"');
});
