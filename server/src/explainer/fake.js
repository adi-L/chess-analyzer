/**
 * Deterministic stand-in for the real explainer. Used by tests so the
 * importer can be exercised without spawning Claude.
 */
export class FakeExplainer {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.calls = [];
  }

  async explain({ game, moments }) {
    this.calls.push({ game, moments });
    return moments.map((m) => {
      if (this.fail) return null;
      const top = m.engineLines?.[0]?.move ?? m.playedMove;
      return {
        ply: m.ply,
        teachMove: top,
        whatWentWrong: `${m.playedMove} lost ${(m.centipawnLoss / 100).toFixed(1)} pawns.`,
        whyBetter: `${top} keeps the position level.`,
        pattern: m.kind === 'missed_win' ? 'missed capture' : 'hanging piece',
      };
    });
  }
}
