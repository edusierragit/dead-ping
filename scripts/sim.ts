// Balance harness: pit the AI against itself and verify matches end decisively
// in a sane number of turns. Run with: npm run sim
import { AiBrain } from '../src/game/ai';
import { createMatch, resolveTurn } from '../src/game/rules';
import { mulberry32 } from '../src/game/types';

const N = 300;
const turns: number[] = [];
const wins: Record<string, number> = { player: 0, enemy: 0, draw: 0 };
const reasons: Record<string, number> = {};

for (let i = 0; i < N; i++) {
  const rng = mulberry32(123456 + i * 7919);
  const state = createMatch(rng);
  const a = new AiBrain('player', state);
  const b = new AiBrain('enemy', state);
  while (!state.result) {
    const acts = { player: a.decide(state, rng), enemy: b.decide(state, rng) };
    const report = resolveTurn(state, acts, rng);
    a.observe(state, report);
    b.observe(state, report);
  }
  turns.push(state.turn);
  wins[state.result.winner]++;
  reasons[state.result.reason] = (reasons[state.result.reason] ?? 0) + 1;
}

turns.sort((x, y) => x - y);
const avg = turns.reduce((s, t) => s + t, 0) / N;
console.log('matches :', N);
console.log('results :', wins);
console.log('reasons :', reasons);
console.log('turns   : avg', avg.toFixed(1), '| median', turns[N >> 1], '| p90', turns[Math.floor(N * 0.9)], '| max', turns[N - 1]);
