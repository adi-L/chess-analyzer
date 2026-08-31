#!/usr/bin/env node
// Deterministic fake UCI engine used only to exercise Engine's own command
// serialization. Unlike real Stockfish, it deliberately has no internal
// queuing: "position" overwrites a single shared variable immediately, and
// each "go" reply is computed from whatever that shared variable holds when
// the reply actually fires (after a short delay) — not from whatever it held
// when "go" was received. This reproduces, deterministically, the class of
// bug Engine's #serialize mutex exists to prevent: if Engine sends a second
// "position"/"go" pair before consuming the first "go"'s reply, this fake
// engine will visibly attribute the wrong evaluation to the wrong position.
let currentFen = null;
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const raw of lines) {
    const cmd = raw.trim();
    if (!cmd) continue;
    if (cmd === 'uci') {
      console.log('id name MockEngine');
      console.log('uciok');
    } else if (cmd === 'isready') {
      console.log('readyok');
    } else if (cmd.startsWith('position fen ')) {
      currentFen = cmd.slice('position fen '.length);
    } else if (cmd.startsWith('go depth')) {
      setTimeout(() => {
        // Deliberately reads currentFen NOW, not at the time "go" arrived.
        const cp = currentFen.startsWith('rnb1kbnr') ? 900 : 10;
        console.log(`info depth 10 seldepth 10 multipv 1 score cp ${cp} nodes 1 nps 1 pv e2e4`);
        console.log(`info depth 10 seldepth 10 multipv 2 score cp ${cp - 1} nodes 1 nps 1 pv d2d4`);
        console.log(`info depth 10 seldepth 10 multipv 3 score cp ${cp - 2} nodes 1 nps 1 pv g1f3`);
        console.log('bestmove e2e4');
      }, 30);
    } else if (cmd === 'quit') {
      process.exit(0);
    }
  }
});
