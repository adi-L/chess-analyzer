import { spawn, spawnSync } from 'node:child_process';
import { Chess } from 'chess.js';
import { collectBestLines, toCentipawns, toWhitePov } from './uci.js';

const DEFAULT_PATH = process.env.STOCKFISH_PATH || 'stockfish';

/** Cheap probe so tests can skip rather than fail when the binary is absent. */
export function stockfishAvailable(path = DEFAULT_PATH) {
  const probe = spawnSync(path, ['--help'], { timeout: 5000 });
  return !probe.error;
}

export class Engine {
  #proc = null;
  #buffer = '';
  #waiters = [];

  constructor({ path = DEFAULT_PATH, depth = 14, multipv = 3 } = {}) {
    this.path = path;
    this.depth = depth;
    this.multipv = multipv;
  }

  async start() {
    this.#proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => this.#onData(chunk));

    await this.#command('uci', (l) => l === 'uciok');
    this.#send(`setoption name MultiPV value ${this.multipv}`);
    await this.#command('isready', (l) => l === 'readyok');
    return this;
  }

  async analyze(fen) {
    const sideToMove = fen.split(' ')[1];
    this.#send(`position fen ${fen}`);
    const output = await this.#command(`go depth ${this.depth}`, (l) => l.startsWith('bestmove'));

    const lines = collectBestLines(output).map((l) => ({
      multipv: l.multipv,
      move: l.pv[0] ?? null,
      pv: l.pv,
      cpWhite: toWhitePov(toCentipawns(l.score), sideToMove),
    }));

    return { evalWhite: lines.length ? lines[0].cpWhite : null, lines };
  }

  /** Apply a UCI move to a position and evaluate what it leads to. */
  async evaluateMove(fen, uciMove) {
    if (typeof uciMove !== 'string' || uciMove.length < 4) return null;
    const board = new Chess(fen);
    let move = null;
    try {
      move = board.move({
        from: uciMove.slice(0, 2),
        to: uciMove.slice(2, 4),
        promotion: uciMove.slice(4) || undefined,
      });
    } catch {
      return null;
    }
    if (!move) return null;

    const { evalWhite } = await this.analyze(board.fen());
    return { san: move.san, fenAfter: board.fen(), evalWhite };
  }

  async quit() {
    if (!this.#proc) return;
    this.#send('quit');
    const proc = this.#proc;
    this.#proc = null;
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000).unref();
    });
  }

  #send(cmd) {
    this.#proc.stdin.write(cmd + '\n');
  }

  /** Register the waiter *before* writing, otherwise fast replies are missed. */
  #command(cmd, predicate) {
    const done = new Promise((resolve) => this.#waiters.push({ predicate, lines: [], resolve }));
    this.#send(cmd);
    return done;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    this.#buffer = parts.pop();
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const waiter = this.#waiters[0];
      if (!waiter) continue;
      waiter.lines.push(line);
      if (waiter.predicate(line)) {
        this.#waiters.shift();
        waiter.resolve(waiter.lines);
      }
    }
  }
}
