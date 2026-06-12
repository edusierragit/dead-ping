import { genMap, pickSpawn, spawnZones } from './map';
import {
  Action, Bloom, DASH_MAX, DASH_MIN, DECOY_COUNT, DECOY_LIFE, DIRS, GRID, GameMap, HULL_MAX,
  LISTEN_CLOSE, MatchState, PRESSURE_HARD, PRESSURE_SOFT, Rng, Side, SubState, TORPEDO_COOLDOWN,
  TORPEDO_RANGE, TREMOR_DIST, TURN_CAP, TurnReport, Vec, eq, idx, inGrid, manhattan, octantOf, other,
} from './types';

export function passable(map: GameMap, v: Vec): boolean {
  return inGrid(v) && !map.rock[idx(v)];
}

export function driftTargets(map: GameMap, pos: Vec): Vec[] {
  return DIRS.map(d => ({ x: pos.x + d.x, y: pos.y + d.y })).filter(v => passable(map, v));
}

export function dashTargets(map: GameMap, pos: Vec): Vec[] {
  const out: Vec[] = [];
  for (const d of DIRS) {
    let cur = pos;
    for (let step = 1; step <= DASH_MAX; step++) {
      cur = { x: cur.x + d.x, y: cur.y + d.y };
      if (!passable(map, cur)) break;
      if (step >= DASH_MIN) out.push(cur);
    }
  }
  return out;
}

export function torpedoTargets(pos: Vec): Vec[] {
  const out: Vec[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const d = manhattan(pos, { x, y });
      if (d >= 1 && d <= TORPEDO_RANGE) out.push({ x, y });
    }
  }
  return out;
}

export function createMatch(rng: Rng): MatchState {
  const map = genMap(rng);
  const zones = spawnZones(rng);
  const mkSub = (zone: Vec[]): SubState => ({
    pos: pickSpawn(zone, map, rng),
    hull: HULL_MAX,
    cooldown: 0,
    decoysLeft: DECOY_COUNT,
    shots: 0,
    hits: 0,
    noise: 0,
  });
  return {
    turn: 0,
    map,
    subs: { player: mkSub(zones.player), enemy: mkSub(zones.enemy) },
    decoys: [],
    zones,
    result: null,
  };
}

export function resolveTurn(state: MatchState, actions: Record<Side, Action>, rng: Rng): TurnReport {
  state.turn++;
  const turn = state.turn;
  const report: TurnReport = {
    turn,
    actions,
    moves: [],
    contacts: [],
    explosions: [],
    damage: [],
    reveals: [],
    bearings: [],
    tremor: false,
    pressure: turn >= PRESSURE_HARD ? 2 : turn >= PRESSURE_SOFT ? 1 : 0,
  };
  const sides: Side[] = ['player', 'enemy'];
  const clamp = (n: number) => Math.max(0, Math.min(GRID - 1, n));
  const jitter = (v: Vec): Vec => ({
    x: clamp(v.x + Math.floor(rng() * 3) - 1),
    y: clamp(v.y + Math.floor(rng() * 3) - 1),
  });
  // chebyshev ≤1 matches the jitter envelope: any bloom a vent could have produced
  const nearVent = (v: Vec) =>
    state.map.vents.some(o => Math.max(Math.abs(o.x - v.x), Math.abs(o.y - v.y)) <= 1);
  const hear = (perceiver: Side, bloom: Bloom) =>
    report.contacts.push({ perceiver, bloom, nearVent: nearVent(bloom.pos) });

  // 1. movement (drift / dash / decoy-drop-and-slip)
  for (const s of sides) {
    const a = actions[s];
    const sub = state.subs[s];
    if (a.type === 'drift' || a.type === 'dash' || a.type === 'decoy') {
      const from = { ...sub.pos };
      const valid = a.type === 'dash' ? dashTargets(state.map, from) : driftTargets(state.map, from);
      const to = valid.some(v => eq(v, a.to)) ? { ...a.to } : from;
      if (a.type === 'decoy' && sub.decoysLeft > 0) {
        sub.decoysLeft--;
        state.decoys.push({ owner: s, pos: from, born: turn });
      }
      sub.pos = { ...to };
      report.moves.push({ side: s, from, to });
      if (a.type === 'dash') {
        sub.noise += 2;
        hear(other(s), { pos: from, kind: 'cavitation', intensity: 2, turn });
      }
    }
  }

  // 2. loud stationary actions scream your true position
  for (const s of sides) {
    const a = actions[s];
    if (a.type === 'ping' || a.type === 'torpedo') {
      state.subs[s].noise += 3;
      hear(other(s), { pos: { ...state.subs[s].pos }, kind: 'scream', intensity: 3, turn });
    }
  }

  // 3. torpedoes detonate against post-move positions
  for (const s of sides) {
    const a = actions[s];
    if (a.type !== 'torpedo') continue;
    const sub = state.subs[s];
    if (sub.cooldown > 0) continue;
    sub.cooldown = TORPEDO_COOLDOWN;
    sub.shots++;
    let oppDamage = 0;
    for (const t of sides) {
      const victim = state.subs[t];
      const d = manhattan(victim.pos, a.target);
      const dmg = d === 0 ? 2 : d === 1 ? 1 : 0;
      if (dmg > 0) {
        victim.hull = Math.max(0, victim.hull - dmg);
        report.damage.push({ side: t, amount: dmg });
        if (t !== s) {
          oppDamage = dmg;
          sub.hits++;
        }
      }
    }
    report.explosions.push({ side: s, target: { ...a.target }, oppDamage });
  }

  // 4. active sonar reveals post-move truth
  for (const s of sides) {
    if (actions[s].type === 'ping') {
      report.reveals.push({ perceiver: s, pos: { ...state.subs[other(s)].pos } });
    }
  }

  // 5. passive listening gives a bearing
  for (const s of sides) {
    if (actions[s].type === 'listen') {
      const me = state.subs[s].pos;
      const op = state.subs[other(s)].pos;
      report.bearings.push({
        perceiver: s,
        octant: octantOf(me, op),
        close: manhattan(me, op) <= LISTEN_CLOSE,
      });
    }
  }

  // 6. decoys drift and lie
  state.decoys = state.decoys.filter(d => turn - d.born < DECOY_LIFE);
  for (const d of state.decoys) {
    if (rng() < 0.3) {
      const opts = driftTargets(state.map, d.pos);
      if (opts.length) d.pos = { ...opts[Math.floor(rng() * opts.length)] };
    }
    if (rng() < 0.7) {
      hear(other(d.owner), { pos: jitter(d.pos), kind: 'murmur', intensity: 1, turn });
    }
  }

  // 7. thermal vents pollute the soundscape for both hunters
  for (const v of state.map.vents) {
    if (rng() < 0.45) {
      const pos = jitter(v);
      hear('player', { pos: { ...pos }, kind: 'murmur', intensity: 1, turn });
      hear('enemy', { pos: { ...pos }, kind: 'murmur', intensity: 1, turn });
    }
  }

  // 8. abyssal pressure: late game, hulls leak sound in alternating waves
  if (report.pressure > 0) {
    for (const s of sides) {
      if ((turn % 2 === 0) !== (s === 'player')) continue;
      const pos = report.pressure === 2 ? { ...state.subs[s].pos } : jitter(state.subs[s].pos);
      state.subs[s].noise += 1;
      hear(other(s), { pos, kind: 'murmur', intensity: report.pressure, turn });
    }
  }

  // 9. proximity tremor
  report.tremor = manhattan(state.subs.player.pos, state.subs.enemy.pos) <= TREMOR_DIST;

  // 10. outcome
  const pDead = state.subs.player.hull <= 0;
  const eDead = state.subs.enemy.hull <= 0;
  if (pDead && eDead) state.result = { winner: 'draw', reason: 'mutual' };
  else if (eDead) state.result = { winner: 'player', reason: 'kill' };
  else if (pDead) state.result = { winner: 'enemy', reason: 'kill' };
  else if (turn >= TURN_CAP) state.result = { winner: 'draw', reason: 'abyss' };

  // 11. reload progresses at end of turn
  for (const s of sides) {
    if (state.subs[s].cooldown > 0) state.subs[s].cooldown--;
  }

  return report;
}
