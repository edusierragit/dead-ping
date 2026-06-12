// Persistent logbook in localStorage: dives, kills, streaks, accuracy.
export interface Logbook {
  dives: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
  shots: number;
  hitsLanded: number;
  onlineWins: number;
  onlineLosses: number;
}

const KEY = 'deadping.logbook.v1';

const EMPTY: Logbook = {
  dives: 0, wins: 0, losses: 0, draws: 0,
  streak: 0, bestStreak: 0, shots: 0, hitsLanded: 0,
  onlineWins: 0, onlineLosses: 0,
};

export function loadLogbook(): Logbook {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch { /* corrupted or unavailable: start fresh */ }
  return { ...EMPTY };
}

export function recordMatch(
  outcome: 'win' | 'loss' | 'draw',
  shots: number,
  hits: number,
  online: boolean,
): Logbook {
  const lb = loadLogbook();
  lb.dives++;
  lb.shots += shots;
  lb.hitsLanded += hits;
  if (outcome === 'win') {
    lb.wins++;
    lb.streak++;
    lb.bestStreak = Math.max(lb.bestStreak, lb.streak);
    if (online) lb.onlineWins++;
  } else if (outcome === 'loss') {
    lb.losses++;
    lb.streak = 0;
    if (online) lb.onlineLosses++;
  } else {
    lb.draws++;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(lb));
  } catch { /* storage may be unavailable */ }
  return lb;
}

export function logbookLine(lb: Logbook): string {
  if (lb.dives === 0) return 'BITÁCORA — primera inmersión.';
  const acc = lb.shots > 0 ? Math.round(100 * lb.hitsLanded / lb.shots) : 0;
  let line = `BITÁCORA — ${lb.dives} inmersiones · ${lb.wins} cazas · ${lb.losses} hundimientos · precisión ${acc}%`;
  if (lb.streak >= 2) line += ` · racha ${lb.streak}`;
  if (lb.bestStreak >= 2) line += ` (mejor ${lb.bestStreak})`;
  if (lb.onlineWins + lb.onlineLosses > 0) line += ` · online ${lb.onlineWins}-${lb.onlineLosses}`;
  return line;
}
