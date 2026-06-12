import { dashTargets, driftTargets, torpedoTargets } from './rules';
import {
  Action, Bloom, GRID, GameMap, MatchState, PRESSURE_HARD, PRESSURE_SOFT, Rng, Side,
  TORPEDO_RANGE, TurnReport, Vec, LISTEN_CLOSE, idx, inGrid, manhattan, neighbors, octantOf, other,
} from './types';

// The AI tracks a probability grid of where the opponent might be and updates it
// with every sound it hears. It cannot tell a decoy from a hull — that is the game.
export class AiBrain {
  side: Side;
  private map: GameMap;
  private belief: Float64Array;
  private exposedTurn = -99;
  private exposedPos: Vec | null = null;
  private lastPing = -99;
  private lastListen = -99;

  constructor(side: Side, state: MatchState) {
    this.side = side;
    this.map = state.map;
    this.belief = new Float64Array(GRID * GRID);
    for (const v of state.zones[other(side)]) {
      if (!this.map.rock[idx(v)]) this.belief[idx(v)] = 1;
    }
    this.normalize();
  }

  private normalize() {
    let s = 0;
    for (let i = 0; i < this.belief.length; i++) {
      if (this.map.rock[i]) this.belief[i] = 0;
      s += this.belief[i];
    }
    if (s < 1e-12) {
      let n = 0;
      for (let i = 0; i < this.belief.length; i++) if (!this.map.rock[i]) n++;
      for (let i = 0; i < this.belief.length; i++) this.belief[i] = this.map.rock[i] ? 0 : 1 / n;
      return;
    }
    for (let i = 0; i < this.belief.length; i++) this.belief[i] /= s;
  }

  // the opponent may have moved one cell since we last heard anything
  private diffuse() {
    const out = new Float64Array(GRID * GRID);
    for (let i = 0; i < this.belief.length; i++) {
      const p = this.belief[i];
      if (p <= 0) continue;
      const v = { x: i % GRID, y: Math.floor(i / GRID) };
      const ns = neighbors(v).filter(n => !this.map.rock[idx(n)]);
      if (ns.length === 0) {
        out[i] += p;
        continue;
      }
      out[i] += p * 0.35;
      for (const n of ns) out[idx(n)] += p * 0.65 / ns.length;
    }
    this.belief = out;
    this.normalize();
  }

  private setExact(pos: Vec) {
    this.belief.fill(0);
    this.belief[idx(pos)] = 1;
  }

  private bump(pos: Vec, mass: number) {
    const cells: { i: number; w: number }[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const v = { x: pos.x + dx, y: pos.y + dy };
        if (!inGrid(v) || this.map.rock[idx(v)]) continue;
        cells.push({ i: idx(v), w: dx === 0 && dy === 0 ? 2 : 1 });
      }
    }
    const tw = cells.reduce((s, c) => s + c.w, 0);
    if (tw === 0) return;
    for (const c of cells) this.belief[c.i] += mass * c.w / tw;
  }

  private applyBloom(bloom: Bloom, nearVent: boolean) {
    if (bloom.kind === 'scream') {
      this.setExact(bloom.pos);
      return;
    }
    if (bloom.kind === 'cavitation') {
      // dash origin: they are now 2-3 cells away in a straight line
      const cells = dashTargets(this.map, bloom.pos);
      const out = new Float64Array(GRID * GRID);
      for (let i = 0; i < out.length; i++) out[i] = this.belief[i] * 0.15;
      if (cells.length) {
        for (const v of cells) out[idx(v)] += 0.85 / cells.length;
      } else {
        this.belief = out;
        this.bump(bloom.pos, 0.85);
        return;
      }
      this.belief = out;
      return;
    }
    // intensity-2 murmurs only come from crush-depth leaks: exact, unfakeable
    if (bloom.intensity >= 2 && !nearVent) {
      for (let i = 0; i < this.belief.length; i++) this.belief[i] *= 0.15;
      this.belief[idx(bloom.pos)] += 0.85;
      return;
    }
    // intensity-1 murmur: could be a hull leak, a decoy, or a vent
    this.bump(bloom.pos, nearVent ? 0.06 : 0.25);
  }

  private applyBearing(from: Vec, octant: number, close: boolean) {
    for (let i = 0; i < this.belief.length; i++) {
      if (this.belief[i] <= 0) continue;
      const v = { x: i % GRID, y: Math.floor(i / GRID) };
      let f = octantOf(from, v) === octant ? 1 : 0.06;
      const m = manhattan(from, v);
      if (close) f *= m <= LISTEN_CLOSE ? 1 : 0.05;
      else f *= m <= LISTEN_CLOSE ? 0.08 : 1;
      this.belief[i] *= f;
    }
  }

  observe(state: MatchState, report: TurnReport) {
    const me = this.side;
    const myAction = report.actions[me];
    // remember when we gave ourselves away
    if (myAction.type === 'dash' || myAction.type === 'ping' || myAction.type === 'torpedo' ||
        report.actions[other(me)].type === 'ping') {
      this.exposedTurn = report.turn;
      this.exposedPos = { ...state.subs[me].pos };
    }
    if (myAction.type === 'ping') this.lastPing = report.turn;
    if (myAction.type === 'listen') this.lastListen = report.turn;

    for (const c of report.contacts) {
      if (c.perceiver === me) this.applyBloom(c.bloom, c.nearVent);
    }
    for (const r of report.reveals) {
      if (r.perceiver === me) this.setExact(r.pos);
    }
    for (const b of report.bearings) {
      if (b.perceiver === me) this.applyBearing(state.subs[me].pos, b.octant, b.close);
    }
    for (const ex of report.explosions) {
      if (ex.side !== me) continue;
      if (ex.oppDamage === 2) {
        this.setExact(ex.target);
      } else if (ex.oppDamage === 1) {
        // splash hit: they are on one of the four adjacent cells
        const keep = neighbors(ex.target).filter(v => !this.map.rock[idx(v)]);
        const out = new Float64Array(GRID * GRID);
        for (const v of keep) out[idx(v)] = Math.max(this.belief[idx(v)], 1e-6);
        this.belief = out;
      } else {
        this.belief[idx(ex.target)] = 0;
        for (const v of neighbors(ex.target)) this.belief[idx(v)] = 0;
      }
    }
    this.normalize();
  }

  decide(state: MatchState, rng: Rng): Action {
    this.diffuse();
    const me = state.subs[this.side];
    const opp = state.subs[other(this.side)];
    const turn = state.turn;
    const drifts = driftTargets(this.map, me.pos);
    const listen: Action = { type: 'listen' };

    // best torpedo shot by expected damage
    let bestT: Vec | null = null;
    let bestEV = 0;
    if (me.cooldown === 0) {
      for (const t of torpedoTargets(me.pos)) {
        if (manhattan(t, me.pos) <= 1) continue; // never splash ourselves
        let ev = 2 * this.belief[idx(t)];
        for (const n of neighbors(t)) ev += this.belief[idx(n)];
        if (ev > bestEV + 1e-9) {
          bestEV = ev;
          bestT = t;
        }
      }
    }
    const pressure = turn + 1 >= PRESSURE_HARD ? 2 : turn + 1 >= PRESSURE_SOFT ? 1 : 0;
    const aggr = 1 + 0.3 * pressure + (opp.hull <= 2 ? 0.3 : 0);
    const exposedNow = turn - this.exposedTurn <= 1 && this.exposedPos !== null;
    // marginal shots sometimes wait a beat — desyncs duels, adds unpredictability
    if (bestT && bestEV >= 0.55 / aggr && (bestEV >= 1.0 || rng() < 0.8)) {
      return { type: 'torpedo', target: bestT };
    }

    // recently exposed: assume incoming fire and slip away
    if (exposedNow && this.exposedPos) {
      const threat = this.exposedPos;
      const away = (opts: Vec[]) =>
        opts.slice().sort((a, b) => (manhattan(b, threat) - manhattan(a, threat)) || rng() - 0.5)[0];
      if (me.decoysLeft > 0 && drifts.length && rng() < 0.45) return { type: 'decoy', to: away(drifts) };
      const dashes = dashTargets(this.map, me.pos);
      if (dashes.length && rng() < 0.3) return { type: 'dash', to: away(dashes) };
      if (drifts.length) return { type: 'drift', to: away(drifts) };
      return listen;
    }

    let pmax = 0;
    let tIdx = 0;
    for (let i = 0; i < this.belief.length; i++) {
      if (this.belief[i] > pmax) {
        pmax = this.belief[i];
        tIdx = i;
      }
    }
    const tgt: Vec = { x: tIdx % GRID, y: Math.floor(tIdx / GRID) };
    const dist = manhattan(me.pos, tgt);
    const toward = (opts: Vec[]) =>
      opts.slice().sort((a, b) => (manhattan(a, tgt) - manhattan(b, tgt)) || rng() - 0.5)[0];

    // lost the trail: gather information
    if (pmax < 0.09) {
      if (turn - this.lastListen >= 3) return listen;
      if (turn - this.lastPing >= 8 && me.hull >= 2 && rng() < 0.35) return { type: 'ping' };
    }

    if (dist > TORPEDO_RANGE) {
      if (dist >= 6 && pmax > 0.2 && rng() < 0.45) {
        const dashes = dashTargets(this.map, me.pos);
        if (dashes.length) {
          const d = toward(dashes);
          if (manhattan(d, tgt) <= dist - 2) return { type: 'dash', to: d };
        }
      }
      if (drifts.length) {
        const d = toward(drifts);
        if (manhattan(d, tgt) < dist) return { type: 'drift', to: d };
      }
      return listen;
    }

    // in range but reloading: keep spacing, keep listening
    if (me.cooldown > 0) {
      if (dist <= 1 && drifts.length) {
        return { type: 'drift', to: drifts.slice().sort((a, b) => manhattan(b, tgt) - manhattan(a, tgt))[0] };
      }
      if (rng() < 0.6) return listen;
      return drifts.length ? { type: 'drift', to: drifts[Math.floor(rng() * drifts.length)] } : listen;
    }

    // tube ready but the read is weak: sharpen it
    if (turn - this.lastListen >= 2) return listen;
    if (pmax > 0.18 && turn - this.lastPing >= 6 && me.hull >= 2 && rng() < 0.5) return { type: 'ping' };
    if (drifts.length && rng() < 0.5) return { type: 'drift', to: toward(drifts) };
    return listen;
  }
}
