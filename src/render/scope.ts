import { Bloom, GRID, HULL_MAX, MatchState, Side, Vec, neighbors, other } from '../game/types';

export interface View {
  contacts: Bloom[];
  lastKnown: { pos: Vec; turn: number } | null;
  bearing: { octant: number; close: boolean; turn: number } | null;
  subAnim: { from: Vec; to: Vec; start: number; dur: number } | null;
  facing: number;
}

export type FxKind = 'ripple' | 'ping' | 'explosion' | 'reveal' | 'trail' | 'label';
export interface Fx {
  kind: FxKind;
  pos: Vec;
  from?: Vec;
  start: number;
  dur: number;
  big?: boolean;
  text?: string;
  color?: string; // 'r,g,b'
}

// ---- perspective projection: the board is a tilted plane in an abyssal arena ----
const SIZE = 860;
const TOP = 86;
const BOTTOM = 44;
const CX = SIZE / 2;
const S_FAR = 0.66; // row scale at the far edge
const S_NEAR = 1.16; // row scale at the near edge
const CS = (SIZE - TOP - BOTTOM) / (GRID * ((S_FAR + S_NEAR) / 2));
const SQ = 0.58; // vertical squash for anything lying on the seafloor

const rowScale = (wy: number) => S_FAR + (S_NEAR - S_FAR) * (wy / GRID);

const ROWY: number[] = (() => {
  const a: number[] = [];
  let y = TOP;
  for (let r = 0; r <= GRID; r++) {
    a.push(y);
    y += CS * rowScale(r + 0.5);
  }
  return a;
})();

function project(wx: number, wy: number): { x: number; y: number; s: number } {
  const w = Math.max(0, Math.min(GRID, wy));
  const ri = Math.min(GRID - 1, Math.floor(w));
  const y = ROWY[ri] + (ROWY[ri + 1] - ROWY[ri]) * (w - ri);
  const s = rowScale(w);
  return { x: CX + (wx - GRID / 2) * CS * s, y, s };
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

export function emptyView(): View {
  return { contacts: [], lastKnown: null, bearing: null, subAnim: null, facing: -Math.PI / 2 };
}

export class Scope {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  state: MatchState | null = null;
  mySide: Side = 'player';
  view: View = emptyView();
  fx: Fx[] = [];
  targets: { cells: Vec[]; kind: 'move' | 'fire' } | null = null;
  hover: Vec | null = null;
  private shake = { until: 0, mag: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  cellAt(clientX: number, clientY: number): Vec | null {
    const rct = this.canvas.getBoundingClientRect();
    const x = (clientX - rct.left) * (SIZE / rct.width);
    const y = (clientY - rct.top) * (SIZE / rct.height);
    for (let r = 0; r < GRID; r++) {
      if (y >= ROWY[r] && y < ROWY[r + 1]) {
        const s = rowScale(r + 0.5);
        const col = Math.floor((x - CX) / (CS * s) + GRID / 2);
        return col >= 0 && col < GRID ? { x: col, y: r } : null;
      }
    }
    return null;
  }

  center(v: Vec) {
    return project(v.x + 0.5, v.y + 0.5);
  }

  addShake(mag: number, dur: number) {
    this.shake = { until: performance.now() + dur, mag };
  }

  private cellPath(v: Vec, inset = 0) {
    const ctx = this.ctx;
    const a = project(v.x + inset, v.y + inset);
    const b = project(v.x + 1 - inset, v.y + inset);
    const c = project(v.x + 1 - inset, v.y + 1 - inset);
    const d = project(v.x + inset, v.y + 1 - inset);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  // ellipse lying flat on the seafloor
  private floorEllipse(x: number, y: number, r: number, stroke: boolean) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * SQ, 0, 0, Math.PI * 2);
    if (stroke) ctx.stroke();
    else ctx.fill();
  }

  draw(now: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();

    if (now < this.shake.until) {
      const k = (this.shake.until - now) / 500;
      ctx.translate(Math.sin(now * 0.11) * this.shake.mag * k, Math.cos(now * 0.13) * this.shake.mag * k);
    }

    // --- abyss backdrop ---
    const bg = ctx.createLinearGradient(0, 0, 0, SIZE);
    bg.addColorStop(0, '#010308');
    bg.addColorStop(0.55, '#021019');
    bg.addColorStop(1, '#04192a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // god rays sinking from above
    for (let i = 0; i < 3; i++) {
      const rx = SIZE * (0.18 + i * 0.3) + Math.sin(now / 9000 + i * 2) * 40;
      const g = ctx.createLinearGradient(rx, 0, rx + 120, SIZE);
      g.addColorStop(0, 'rgba(90,180,220,0.045)');
      g.addColorStop(1, 'rgba(90,180,220,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(rx - 30, 0);
      ctx.lineTo(rx + 60, 0);
      ctx.lineTo(rx + 190, SIZE);
      ctx.lineTo(rx - 10, SIZE);
      ctx.closePath();
      ctx.fill();
    }

    // marine snow with depth parallax
    for (let i = 0; i < 54; i++) {
      const depth = hash(i * 5 + 3); // 0 far, 1 near
      const speed = 3 + depth * 11;
      const x = (((hash(i * 3 + 1) * SIZE + now * 0.002 * (hash(i) - 0.5) * 9) % SIZE) + SIZE) % SIZE;
      const y = (((hash(i * 7 + 2) * SIZE + now * speed / 1000) % SIZE) + SIZE) % SIZE;
      ctx.fillStyle = `rgba(150,210,235,${0.025 + depth * 0.075})`;
      const sz = 1 + depth * 1.3;
      ctx.fillRect(x, y, sz, sz);
    }

    const s = this.state;
    if (!s) {
      ctx.restore();
      return;
    }

    // --- the sonar plane ---
    // floor glow
    const fg = ctx.createRadialGradient(CX, ROWY[GRID] * 0.92, 40, CX, ROWY[GRID] * 0.92, SIZE * 0.75);
    fg.addColorStop(0, 'rgba(20,90,130,0.20)');
    fg.addColorStop(1, 'rgba(20,90,130,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    const tl = project(0, 0);
    const tr = project(GRID, 0);
    const br = project(GRID, GRID);
    const bl = project(0, GRID);
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fill();

    // grid lines (converging with perspective)
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID; i++) {
      const edge = i === 0 || i === GRID;
      ctx.strokeStyle = `rgba(86,200,255,${edge ? 0.26 : 0.11})`;
      const a = project(i, 0);
      const b = project(i, GRID);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const l = project(0, i);
      const rr = project(GRID, i);
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(rr.x, rr.y);
      ctx.stroke();
    }
    // coordinates, small and quiet
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < GRID; i++) {
      ctx.fillStyle = 'rgba(86,200,255,0.30)';
      const t = project(i + 0.5, -0.4);
      ctx.fillText(String.fromCharCode(65 + i), t.x, t.y);
      const l = project(-0.45, i + 0.5);
      ctx.fillText(String(i + 1), l.x, l.y);
    }

    // --- rocks with volume ---
    for (let i = 0; i < s.map.rock.length; i++) {
      if (!s.map.rock[i]) continue;
      const v = { x: i % GRID, y: Math.floor(i / GRID) };
      const c = this.center(v);
      const h = CS * 0.30 * c.s; // rock height in screen px
      const pts: { x: number; y: number }[] = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const rad = CS * c.s * (0.30 + hash(i * 7 + k) * 0.14);
        pts.push({ x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad * SQ });
      }
      // dark side mass
      ctx.fillStyle = '#050d13';
      ctx.beginPath();
      pts.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y + 1) : ctx.lineTo(p.x, p.y + 1)));
      ctx.closePath();
      ctx.fill();
      // lifted top face
      ctx.fillStyle = '#0c1d28';
      ctx.beginPath();
      pts.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y - h) : ctx.lineTo(p.x, p.y - h)));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,190,220,0.20)';
      ctx.stroke();
    }

    // --- thermal vents ---
    s.map.vents.forEach((v, i) => {
      const c = this.center(v);
      const pulse = 0.5 + 0.5 * Math.sin(now / 420 + i * 1.7);
      const g = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, CS * c.s * 0.9);
      g.addColorStop(0, `rgba(255,170,80,${0.13 + 0.12 * pulse})`);
      g.addColorStop(1, 'rgba(255,170,80,0)');
      ctx.fillStyle = g;
      this.floorEllipse(c.x, c.y, CS * c.s * 0.9, false);
      for (let k = 0; k < 3; k++) {
        const t = ((now / 1600) + k / 3 + i * 0.37) % 1;
        ctx.fillStyle = `rgba(255,195,120,${(1 - t) * 0.55})`;
        ctx.beginPath();
        ctx.arc(c.x + Math.sin(t * 9 + k * 2) * 5 * c.s, c.y - t * CS * c.s * 1.1, 1.6 * c.s, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // player anchor (computed early: light + sweep radiate from you)
    let pp = this.center(s.subs[this.mySide].pos);
    const anim = this.view.subAnim;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.dur);
      const a = this.center(anim.from);
      const b = this.center(anim.to);
      const e = 1 - (1 - t) * (1 - t);
      pp = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, s: a.s + (b.s - a.s) * e };
      if (t >= 1) this.view.subAnim = null;
    }

    // your local light: you only really see near yourself
    const ll = ctx.createRadialGradient(pp.x, pp.y, 8, pp.x, pp.y, CS * 3.4);
    ll.addColorStop(0, 'rgba(84,232,255,0.085)');
    ll.addColorStop(1, 'rgba(84,232,255,0)');
    ctx.fillStyle = ll;
    this.floorEllipse(pp.x, pp.y, CS * 3.4, false);

    // passive sonar pulse breathing out of your hull
    const st = (now / 3600) % 1;
    ctx.strokeStyle = `rgba(84,232,255,${(1 - st) * 0.10})`;
    ctx.lineWidth = 1.5;
    this.floorEllipse(pp.x, pp.y, st * CS * 5.5, true);

    // --- targeting ---
    if (this.targets) {
      const fire = this.targets.kind === 'fire';
      const col = fire ? '255,87,71' : '84,232,255';
      const pulse = 0.5 + 0.5 * Math.sin(now / 250);
      for (const v of this.targets.cells) {
        this.cellPath(v, 0.08);
        ctx.fillStyle = `rgba(${col},${0.06 + 0.05 * pulse})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${col},0.35)`;
        ctx.stroke();
      }
      if (this.hover && this.targets.cells.some(v => v.x === this.hover!.x && v.y === this.hover!.y)) {
        this.cellPath(this.hover, 0.08);
        ctx.fillStyle = `rgba(${col},0.25)`;
        ctx.fill();
        if (fire) {
          for (const n of neighbors(this.hover)) {
            this.cellPath(n, 0.2);
            ctx.fillStyle = `rgba(${col},0.10)`;
            ctx.fill();
          }
        }
      }
    }

    // --- sound contacts: amber distortion blooming on the floor ---
    for (const c of this.view.contacts) {
      const age = s.turn - c.turn;
      const alpha = Math.max(0, 1 - age / 4);
      if (alpha <= 0) continue;
      const p = this.center(c.pos);
      const col = c.kind === 'scream' ? '255,87,71' : '255,180,84';
      const wob = 1 + Math.sin(now / 160 + c.pos.x * 5 + c.pos.y * 3) * 0.06;
      const r = CS * p.s * (0.18 + 0.10 * c.intensity) * wob;
      ctx.fillStyle = `rgba(${col},${alpha * 0.9})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2 * p.s, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},${alpha * 0.5})`;
      ctx.lineWidth = 1.5;
      this.floorEllipse(p.x, p.y, r, true);
      if (c.kind !== 'murmur') {
        ctx.strokeStyle = `rgba(${col},${alpha * 0.28})`;
        this.floorEllipse(p.x, p.y, r * 1.7, true);
      }
      ctx.lineWidth = 1;
    }

    // --- last known fix ---
    if (this.view.lastKnown) {
      const age = s.turn - this.view.lastKnown.turn;
      const alpha = Math.max(0, 1 - age / 6);
      if (alpha > 0) {
        const p = this.center(this.view.lastKnown.pos);
        const r = CS * p.s * 0.34;
        ctx.strokeStyle = `rgba(255,87,71,${alpha * 0.9})`;
        ctx.lineWidth = 1.5;
        this.floorEllipse(p.x, p.y, r * 1.2, true);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r * 0.8, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r * 0.8, p.y);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = `rgba(255,87,71,${alpha * 0.8})`;
        ctx.font = `${Math.round(10 * p.s)}px ui-monospace, Consolas, monospace`;
        ctx.fillText(`VISTO·T-${age}`, p.x, p.y + r + 12 * p.s);
        ctx.lineWidth = 1;
      }
    }

    // --- hydrophone bearing wedge ---
    if (this.view.bearing) {
      const age = s.turn - this.view.bearing.turn;
      const alpha = Math.max(0, 1 - age / 2);
      if (alpha > 0) {
        const a = (this.view.bearing.octant * 45 - 90) * Math.PI / 180;
        const reach = CS * (this.view.bearing.close ? 3 : 5);
        ctx.save();
        ctx.translate(pp.x, pp.y);
        ctx.scale(1, SQ);
        const g = ctx.createRadialGradient(0, 0, 8, 0, 0, reach);
        g.addColorStop(0, `rgba(140,255,220,${alpha * 0.22})`);
        g.addColorStop(1, 'rgba(140,255,220,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, reach, a - 0.4, a + 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = `rgba(140,255,220,${alpha * 0.3})`;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * reach, Math.sin(a) * reach);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // --- own decoys ---
    for (const d of s.decoys) {
      if (d.owner !== this.mySide) continue;
      const p = this.center(d.pos);
      ctx.strokeStyle = 'rgba(84,232,255,0.55)';
      ctx.setLineDash([3, 3]);
      this.floorEllipse(p.x, p.y, CS * p.s * 0.26, true);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(84,232,255,0.55)';
      ctx.font = `${Math.round(8 * p.s)}px ui-monospace, Consolas, monospace`;
      ctx.fillText('SEÑUELO', p.x, p.y + CS * p.s * 0.42);
    }

    // --- propeller wake while moving ---
    if (this.view.subAnim) {
      const dir = this.view.facing;
      for (let k = 1; k <= 4; k++) {
        ctx.fillStyle = `rgba(160,240,255,${0.4 - k * 0.08})`;
        ctx.beginPath();
        ctx.arc(
          pp.x - Math.cos(dir) * (CS * 0.3 + k * 7) * pp.s + Math.sin(now / 80 + k) * 2,
          pp.y - Math.sin(dir) * (CS * 0.3 + k * 7) * pp.s * SQ + Math.cos(now / 95 + k) * 2,
          (2.4 - k * 0.4) * pp.s, 0, Math.PI * 2,
        );
        ctx.fill();
      }
    }

    // --- your boat ---
    const bob = Math.sin(now / 600) * 1.5;
    this.drawSub(pp.x, pp.y + bob, pp.s, this.view.facing, {
      dark: '#0b4a63', body: '#54e8ff', sail: '#d8f8ff', glow: '84,232,255',
    });

    // hull ticks under the boat
    const hull = s.subs[this.mySide].hull;
    for (let i = 0; i < HULL_MAX; i++) {
      const tx = pp.x - (HULL_MAX * 9 * pp.s) / 2 + i * 9 * pp.s;
      const ty = pp.y + CS * 0.50 * pp.s;
      if (i < hull) {
        ctx.fillStyle = 'rgba(84,232,255,0.9)';
        ctx.fillRect(tx, ty, 7 * pp.s, 3);
      } else {
        ctx.strokeStyle = 'rgba(84,232,255,0.35)';
        ctx.strokeRect(tx + 0.5, ty + 0.5, 6 * pp.s, 2);
      }
    }

    // --- enemy revealed only when the match ends ---
    if (s.result) {
      const ep = this.center(s.subs[other(this.mySide)].pos);
      this.drawSub(ep.x, ep.y, ep.s, Math.PI / 2, {
        dark: '#6b2218', body: '#ff8a78', sail: '#ffd6cc', glow: '255,87,71',
      });
    }

    // --- effects ---
    this.fx = this.fx.filter(f => now - f.start < f.dur);
    for (const f of this.fx) {
      const t = (now - f.start) / f.dur;
      const p = this.center(f.pos);
      if (f.kind === 'ripple') {
        const r = CS * p.s * (0.3 + t * (f.big ? 2.2 : 1.5));
        ctx.strokeStyle = `rgba(255,180,84,${(1 - t) * 0.7})`;
        ctx.lineWidth = 1.5;
        this.floorEllipse(p.x, p.y, r, true);
        ctx.lineWidth = 1;
      } else if (f.kind === 'ping') {
        for (const off of [0, 0.18]) {
          const tt = t - off;
          if (tt <= 0) continue;
          ctx.strokeStyle = `rgba(84,232,255,${(1 - tt) * 0.5})`;
          ctx.lineWidth = 2;
          this.floorEllipse(p.x, p.y, tt * SIZE * 0.7, true);
        }
        ctx.lineWidth = 1;
      } else if (f.kind === 'explosion') {
        const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, CS * p.s * (0.5 + t * 1.5));
        g.addColorStop(0, `rgba(255,240,210,${(1 - t) * 0.95})`);
        g.addColorStop(0.4, `rgba(255,140,60,${(1 - t) * 0.6})`);
        g.addColorStop(1, 'rgba(255,87,71,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, CS * p.s * (0.5 + t * 1.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,180,84,${(1 - t) * 0.8})`;
        this.floorEllipse(p.x, p.y, t * CS * p.s * (f.big ? 2.7 : 1.9), true);
        for (let k = 0; k < 12; k++) {
          const a = k * 2.39996 + f.start;
          const d = t * CS * p.s * 1.5 * (0.5 + hash(k + f.start) * 0.5);
          ctx.fillStyle = `rgba(255,210,140,${(1 - t) * 0.85})`;
          ctx.fillRect(p.x + Math.cos(a) * d - 1, p.y + Math.sin(a) * d * SQ - 1 - t * 14, 2, 2);
        }
      } else if (f.kind === 'reveal') {
        const r = CS * p.s * (1.6 - t * 1.2);
        ctx.strokeStyle = `rgba(255,87,71,${0.4 + t * 0.5})`;
        ctx.lineWidth = 1.5;
        this.floorEllipse(p.x, p.y, r, true);
        ctx.lineWidth = 1;
      } else if (f.kind === 'label' && f.text) {
        const rise = t * 22;
        const col = f.color ?? '255,180,84';
        ctx.font = 'bold 18px ui-monospace, Consolas, monospace';
        ctx.shadowColor = `rgba(${col},0.9)`;
        ctx.shadowBlur = 10;
        ctx.fillStyle = `rgba(${col},${Math.max(0, 1 - t * 1.1)})`;
        ctx.fillText(f.text, p.x, p.y - CS * 0.7 * p.s - rise);
        ctx.shadowBlur = 0;
        ctx.font = '10px ui-monospace, Consolas, monospace';
      } else if (f.kind === 'trail' && f.from) {
        const a = this.center(f.from);
        const tt = Math.min(1, t / 0.7);
        const mx = a.x + (p.x - a.x) * tt;
        const my = a.y + (p.y - a.y) * tt;
        ctx.strokeStyle = `rgba(255,225,170,${(1 - t) * 0.35})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(mx, my);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,240,210,${1 - t})`;
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- depth fog: the far edge dissolves into the abyss (kept light: info lives there) ---
    const fog = ctx.createLinearGradient(0, 0, 0, SIZE * 0.42);
    fog.addColorStop(0, 'rgba(1,5,10,0.34)');
    fog.addColorStop(1, 'rgba(1,5,10,0)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, SIZE, SIZE * 0.42);

    ctx.restore();
  }

  // top-down submarine: chubby cigar hull, deck line, sail, stern planes, prop
  private drawSub(x: number, y: number, scale: number, facing: number, c: { dark: string; body: string; sail: string; glow: string }) {
    const ctx = this.ctx;
    const L = CS * 0.38 * scale;
    const W = CS * 0.17 * scale;
    ctx.save();
    ctx.translate(x, y);
    // projected shadow on the seafloor
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(5, 8, W * 1.15, L * 0.9 * SQ, facing + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(facing + Math.PI / 2);
    ctx.shadowColor = `rgba(${c.glow},0.8)`;
    ctx.shadowBlur = 14;
    const g = ctx.createLinearGradient(-W, 0, W, 0);
    g.addColorStop(0, c.dark);
    g.addColorStop(0.45, c.body);
    g.addColorStop(1, c.dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-W, 0);
    ctx.bezierCurveTo(-W, -L * 0.72, -W * 0.55, -L, 0, -L);
    ctx.bezierCurveTo(W * 0.55, -L, W, -L * 0.72, W, 0);
    ctx.bezierCurveTo(W, L * 0.78, W * 0.5, L * 0.95, 0, L * 0.95);
    ctx.bezierCurveTo(-W * 0.5, L * 0.95, -W, L * 0.78, -W, 0);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -L * 0.82);
    ctx.lineTo(0, L * 0.8);
    ctx.stroke();
    ctx.strokeStyle = c.body;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-W * 1.55, L * 0.72);
    ctx.lineTo(W * 1.55, L * 0.72);
    ctx.stroke();
    ctx.strokeStyle = c.sail;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, L * 1.05, W * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = c.sail;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-W * 0.34, -L * 0.5, W * 0.68, L * 0.52, W * 0.3);
    else ctx.rect(-W * 0.34, -L * 0.5, W * 0.68, L * 0.52);
    ctx.fill();
    ctx.fillStyle = c.dark;
    ctx.beginPath();
    ctx.arc(0, -L * 0.36, W * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1;
  }
}
