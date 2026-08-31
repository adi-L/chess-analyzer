import express from 'express';
import { openDb, listGames, getGameWithMoments, recordAttempt } from './db.js';
import { Engine, stockfishAvailable } from './engine.js';
import { ClaudeCliExplainer } from './explainer/claudeCli.js';
import { fetchAndImport } from './importer.js';

export function createApp({ db, engine, explainer, username }) {
  const app = express();
  app.use(express.json());

  app.get('/api/games', (req, res) => {
    res.json({ games: listGames(db, username) });
  });

  app.get('/api/games/:uuid', (req, res) => {
    const found = getGameWithMoments(db, req.params.uuid);
    if (!found) return res.status(404).json({ error: 'not found' });
    res.json(found);
  });

  app.post('/api/evaluate', async (req, res) => {
    const { fen, move, momentId } = req.body ?? {};
    if (!fen || !move) return res.status(400).json({ error: 'fen and move are required' });

    const result = await engine.evaluateMove(fen, move);
    if (!result) return res.status(400).json({ error: 'illegal move' });

    if (momentId != null) recordAttempt(db, momentId, result.san, result.evalWhite);
    res.json(result);
  });

  // GET, not POST, so the browser can read it with EventSource.
  app.get('/api/import', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const summary = await fetchAndImport({
        db, engine, explainer, username,
        limit: Number(req.query.limit ?? 10),
        onProgress: (p) => send('progress', p),
      });
      send('done', summary);
    } catch (err) {
      send('error', { message: err.message });
    } finally {
      res.end();
    }
  });

  return app;
}

async function start() {
  const username = process.env.CHESS_USERNAME;
  if (!username) {
    console.error('Set CHESS_USERNAME to the chess.com account you want to review.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);

  if (!stockfishAvailable()) {
    console.error('Stockfish not found. Install it (brew install stockfish) or set STOCKFISH_PATH.');
    process.exit(1);
  }

  const db = openDb();
  const engine = await new Engine().start();
  const explainer = new ClaudeCliExplainer();

  createApp({ db, engine, explainer, username }).listen(port, () => {
    console.log(`chess analyzer server on http://localhost:${port} (user: ${username})`);
  });

  const shutdown = async () => { await engine.quit(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start();
}
