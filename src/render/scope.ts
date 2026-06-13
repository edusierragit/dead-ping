import { Action, ActionType, Bloom, GRID, HULL_MAX, MatchState, OCTANTS, Side, Vec, neighbors, other } from '../game/types';

export interface View {
  contacts: Bloom[];
  lastKnown: { pos: Vec; turn: number } | null;
  bearing: { octant: number; close: boolean; turn: number } | null;
  subAnim: { from: Vec; to: Vec; start: number; dur: number } | null;
  facing: number;
}

export type FxKind = 'ripple' | 'ping' | 'explosion' | 'reveal' | 'trail' | 'label' | 'listen';
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
  myNoise = 0; // 0-3: your recent loudness, painted as amber rings on your boat
  view: View = emptyView();
  fx: Fx[] = [];
  targets: { cells: Vec[]; kind: 'move' | 'fire' } | null = null;
  preview: ActionType | null = null; // hover ghost
  armed: Action | null = null;       // chosen action awaiting confirm
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

    // trench walls: the arena sits inside a crevice, not a void
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#020a12';
      ctx.beginPath();
      const x0 = side === -1 ? 0 : SIZE;
      ctx.moveTo(x0, 0);
      for (let k = 0; k <= 8; k++) {
        const yy = (k / 8) * SIZE;
        const depth = SIZE * (0.05 + hash(k * 13 + (side === -1 ? 0 : 50)) * 0.09) * (1 + yy / SIZE * 0.5);
        ctx.lineTo(x0 + side * -depth, yy);
      }
      ctx.lineTo(x0, SIZE);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(90,190,230,0.10)';
      ctx.stroke();
    }

    this.drawJellies(now);

    const s = this.state;
    if (!s) {
      this.drawAttract(now);
      ctx.restore();
      return;
    }

    // --- the sonar plane: a lit sand arena on the trench floor ---
    const tl = project(0, 0);
    const tr = project(GRID, 0);
    const br = project(GRID, GRID);
    const bl = project(0, GRID);
    const plane = () => {
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
    };
    // sand base
    plane();
    ctx.fillStyle = '#06141f';
    ctx.fill();
    // pooled light
    const fg = ctx.createRadialGradient(CX, ROWY[GRID] * 0.88, 40, CX, ROWY[GRID] * 0.88, SIZE * 0.78);
    fg.addColorStop(0, 'rgba(30,110,150,0.28)');
    fg.addColorStop(1, 'rgba(30,110,150,0)');
    ctx.fillStyle = fg;
    plane();
    ctx.fill();
    // caustic shimmer drifting across the sand
    ctx.save();
    plane();
    ctx.clip();
    for (let k = 0; k < 3; k++) {
      const cxx = CX + Math.sin(now / (5200 + k * 1700) + k * 2.1) * SIZE * 0.32;
      const cyy = TOP + ((now / (90 + k * 25)) % (SIZE - TOP));
      const cg = ctx.createRadialGradient(cxx, cyy, 4, cxx, cyy, 130);
      cg.addColorStop(0, 'rgba(140,230,255,0.045)');
      cg.addColorStop(1, 'rgba(140,230,255,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(cxx, cyy, 130, 60, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // sand speckles
    for (let k = 0; k < 130; k++) {
      const p = project(hash(k * 3) * GRID, hash(k * 7 + 1) * GRID);
      ctx.fillStyle = `rgba(150,210,235,${0.03 + hash(k * 11) * 0.06})`;
      ctx.fillRect(p.x, p.y, 1.4 * p.s, 1.4 * p.s);
    }
    ctx.restore();
    // glowing rim: the arena reads as a place, not a wireframe
    ctx.shadowColor = 'rgba(86,200,255,0.55)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(86,200,255,0.35)';
    ctx.lineWidth = 1.5;
    plane();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;

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

    // --- action preview / armed visualization (teaches what each action does) ---
    this.drawActionViz(pp, now);

    // --- sound contacts: amber distortion blooming on the floor ---
    for (const c of this.view.contacts) {
      const age = s.turn - c.turn;
      const alpha = Math.max(0, 1 - age / 3);
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
      // fresh signals are born with their name: the board teaches its own language
      if (age === 0) {
        ctx.fillStyle = `rgba(${col},0.85)`;
        ctx.font = `${Math.round(9 * p.s)}px ui-monospace, Consolas, monospace`;
        ctx.fillText(
          c.kind === 'murmur' ? 'ruido' : c.kind === 'cavitation' ? 'algo corrió' : '¡GRITO!',
          p.x, p.y + r + 11 * p.s,
        );
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
        // octant tag at the cone's tip
        ctx.fillStyle = `rgba(140,255,220,${alpha * 0.85})`;
        ctx.font = 'bold 14px ui-monospace, Consolas, monospace';
        ctx.fillText(
          OCTANTS[this.view.bearing.octant],
          pp.x + Math.cos(a) * reach * 1.08,
          pp.y + Math.sin(a) * reach * SQ * 1.08,
        );
        ctx.font = '10px ui-monospace, Consolas, monospace';
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
    const dirX = Math.cos(this.view.facing) >= 0 ? 1 : -1;
    this.drawSub(pp.x, pp.y + bob, pp.s, dirX, now, {
      dark: '#0b4a63', body: '#54e8ff', sail: '#d8f8ff', glow: '84,232,255',
    });

    // your exposure made visible: amber sound rings radiate from a loud hull
    if (this.myNoise > 0 && !s.result) {
      for (let i = 0; i < this.myNoise; i++) {
        const ph = ((now / 1100) + i / this.myNoise) % 1;
        ctx.strokeStyle = `rgba(255,180,84,${(1 - ph) * (0.16 + this.myNoise * 0.1)})`;
        ctx.lineWidth = 1.5;
        this.floorEllipse(pp.x, pp.y, CS * pp.s * (0.5 + ph * (0.7 + this.myNoise * 0.5)), true);
      }
      ctx.lineWidth = 1;
      if (this.myNoise >= 2) {
        ctx.fillStyle = 'rgba(255,180,84,0.85)';
        ctx.font = `bold ${Math.round(10 * pp.s)}px ui-monospace, Consolas, monospace`;
        ctx.fillText(this.myNoise >= 3 ? '¡TE ESCUCHAN!' : 'te oyeron', pp.x, pp.y + CS * 0.72 * pp.s);
      }
    }

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
      this.drawSub(ep.x, ep.y, ep.s, -1, now, {
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
      } else if (f.kind === 'listen') {
        // sound converging INTO you: rings collapse toward your hull
        for (const off of [0, 0.25, 0.5]) {
          const tt = (t - off) / 0.5;
          if (tt <= 0 || tt >= 1) continue;
          ctx.strokeStyle = `rgba(140,255,220,${tt * 0.5})`;
          ctx.lineWidth = 1.5;
          this.floorEllipse(p.x, p.y, (1 - tt) * CS * 3, true);
        }
        ctx.lineWidth = 1;
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

  // preview (hover) + armed action: show on the board what an action will do
  private drawActionViz(pp: { x: number; y: number; s: number }, now: number) {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 240);

    // 1. armed action gets a strong, pulsing commitment marker
    if (this.armed) {
      const a = this.armed;
      if (a.type === 'listen') { this.ghostListen(pp, now, 0.9); return; }
      if (a.type === 'ping') { this.ghostPing(pp, now, 0.9); return; }
      const cell = a.type === 'torpedo' ? a.target : a.type === 'drift' || a.type === 'dash' || a.type === 'decoy' ? a.to : null;
      if (!cell) return;
      const fire = a.type === 'torpedo';
      const col = fire ? '255,87,71' : '84,232,255';
      const c = this.center(cell);
      ctx.strokeStyle = `rgba(${col},0.5)`;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(pp.x, pp.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.cellPath(cell, 0.06);
      ctx.fillStyle = `rgba(${col},${0.28 + 0.22 * pulse})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},0.9)`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      if (fire) {
        for (const n of neighbors(cell)) {
          this.cellPath(n, 0.24);
          ctx.fillStyle = `rgba(${col},0.14)`;
          ctx.fill();
        }
      }
      return;
    }

    // 2. hover preview: faint ghost of the hovered action
    if (!this.preview) return;
    const t = this.preview;
    if (t === 'listen') { this.ghostListen(pp, now, 0.4); return; }
    if (t === 'ping') { this.ghostPing(pp, now, 0.4); return; }
    const ring = (cells: number, rgb: string) => {
      ctx.strokeStyle = `rgba(${rgb},0.5)`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 6]);
      this.floorEllipse(pp.x, pp.y, cells * CS * pp.s, true);
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    };
    if (t === 'drift' || t === 'decoy') ring(1, '84,232,255');
    if (t === 'dash') { ring(2, '84,232,255'); ring(3, '84,232,255'); }
    if (t === 'torpedo') ring(4, '255,87,71');
  }

  // quiet listening: soft concentric "ears" — silent, safe
  private ghostListen(pp: { x: number; y: number; s: number }, now: number, alpha: number) {
    const ctx = this.ctx;
    for (let k = 0; k < 3; k++) {
      const t = ((now / 1400) + k / 3) % 1;
      ctx.strokeStyle = `rgba(140,255,220,${alpha * (1 - t) * 0.5})`;
      ctx.lineWidth = 1.5;
      this.floorEllipse(pp.x, pp.y, (0.6 + t * 1.8) * CS * pp.s, true);
    }
    ctx.lineWidth = 1;
    ctx.fillStyle = `rgba(140,255,220,${alpha * 0.85})`;
    ctx.font = `${Math.round(10 * pp.s)}px ui-monospace, Consolas, monospace`;
    ctx.fillText('escuchar · silencioso', pp.x, pp.y - CS * 0.95 * pp.s);
  }

  // active sonar: one huge loud ring sweeping the whole arena — exposes you
  private ghostPing(pp: { x: number; y: number; s: number }, now: number, alpha: number) {
    const ctx = this.ctx;
    const t = (now / 900) % 1;
    ctx.strokeStyle = `rgba(255,180,84,${alpha * (1 - t) * 0.7})`;
    ctx.lineWidth = 2.5;
    this.floorEllipse(pp.x, pp.y, t * SIZE * 0.75, true);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(255,180,84,${alpha * 0.4})`;
    this.floorEllipse(pp.x, pp.y, SIZE * 0.7, true);
    ctx.lineWidth = 1;
    ctx.fillStyle = `rgba(255,180,84,${alpha})`;
    ctx.font = `bold ${Math.round(10 * pp.s)}px ui-monospace, Consolas, monospace`;
    ctx.fillText('PING · TE OYEN A VOS', pp.x, pp.y - CS * 0.95 * pp.s);
  }

  // side-profile submarine billboard: hull, sail, periscope, tail fin,
  // spinning propeller and glowing portholes. Reads as a sub at a glance.
  private drawSub(x: number, y: number, scale: number, dirX: number, now: number, c: { dark: string; body: string; sail: string; glow: string }) {
    const ctx = this.ctx;
    const L = CS * 0.64 * scale;
    const H = CS * 0.20 * scale;
    ctx.save();
    ctx.translate(x, y);
    // floor shadow
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(0, H * 1.7, L * 0.52, H * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.scale(dirX, 1); // nose points along travel direction
    ctx.shadowColor = `rgba(${c.glow},0.8)`;
    ctx.shadowBlur = 16;
    const g = ctx.createLinearGradient(0, -H, 0, H);
    g.addColorStop(0, c.body);
    g.addColorStop(0.55, c.body);
    g.addColorStop(1, c.dark);
    ctx.fillStyle = g;
    // hull: rounded nose right, tapered tail left
    ctx.beginPath();
    ctx.moveTo(-L * 0.5, 0);
    ctx.quadraticCurveTo(-L * 0.25, -H * 0.78, L * 0.1, -H * 0.8);
    ctx.quadraticCurveTo(L * 0.44, -H * 0.8, L * 0.5, 0);
    ctx.quadraticCurveTo(L * 0.44, H * 0.8, L * 0.1, H * 0.8);
    ctx.quadraticCurveTo(-L * 0.25, H * 0.78, -L * 0.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    // sail
    ctx.fillStyle = c.sail;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(L * 0.02, -H * 1.6, L * 0.18, H * 0.9, 3);
    else ctx.rect(L * 0.02, -H * 1.6, L * 0.18, H * 0.9);
    ctx.fill();
    // periscope
    ctx.strokeStyle = c.sail;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(L * 0.08, -H * 1.6);
    ctx.lineTo(L * 0.08, -H * 2.2);
    ctx.lineTo(L * 0.15, -H * 2.2);
    ctx.stroke();
    // tail fin
    ctx.fillStyle = c.body;
    ctx.beginPath();
    ctx.moveTo(-L * 0.36, -H * 0.3);
    ctx.lineTo(-L * 0.52, -H * 1.15);
    ctx.lineTo(-L * 0.44, 0);
    ctx.closePath();
    ctx.fill();
    // spinning propeller
    const spin = Math.abs(Math.sin(now / 130));
    ctx.strokeStyle = c.sail;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(-L * 0.54, 0, H * 0.16, H * 0.6 * spin + 1, 0, 0, Math.PI * 2);
    ctx.stroke();
    // glowing portholes
    ctx.fillStyle = 'rgba(255,240,200,0.95)';
    ctx.shadowColor = 'rgba(255,240,200,0.95)';
    ctx.shadowBlur = 6;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(L * (0.28 - k * 0.16), -H * 0.08, Math.max(1.4, 1.7 * scale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.restore();
    ctx.lineWidth = 1;
  }

  // bioluminescent jellyfish drifting in the background
  private drawJellies(now: number) {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const sp = 26000 + i * 9000;
      const cyc = now / sp + i * 0.37;
      const t = cyc % 1;
      const x = SIZE * (0.1 + 0.8 * hash(i * 11 + Math.floor(cyc))) + Math.sin(now / 2300 + i) * 28;
      const y = SIZE * (1.08 - t * 1.25);
      const size = 15 + hash(i * 7) * 16;
      const pulse = Math.sin(now / 700 + i * 2);
      const alpha = 0.15 * Math.sin(Math.PI * t);
      if (alpha <= 0.01) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.shadowColor = 'rgba(150,170,255,0.8)';
      ctx.shadowBlur = 16;
      ctx.fillStyle = `rgba(150,170,255,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, size * (1 + pulse * 0.08), size * 0.75 * (1 - pulse * 0.1), 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(150,170,255,${alpha * 0.7})`;
      ctx.lineWidth = 1.2;
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(k * size * 0.28, 1);
        ctx.quadraticCurveTo(
          k * size * 0.3 + Math.sin(now / 500 + k + i) * 6,
          size * 0.9,
          k * size * 0.34 + Math.sin(now / 350 + k * 2 + i) * 9,
          size * 1.7,
        );
        ctx.stroke();
      }
      ctx.restore();
      ctx.lineWidth = 1;
    }
  }

  // attract mode behind the title: a lone hunter cruising and pinging the dark
  private drawAttract(now: number) {
    const ctx = this.ctx;
    const t = (now / 26000) * Math.PI * 2;
    const x = CX + Math.cos(t) * SIZE * 0.26;
    const y = SIZE * 0.6 + Math.sin(t * 2) * 42;
    const dirX = -Math.sin(t) >= 0 ? 1 : -1;
    const pt = (now % 5200) / 5200;
    ctx.strokeStyle = `rgba(84,232,255,${(1 - pt) * 0.22})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y, pt * 330, pt * 230, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    this.drawSub(x, y, 1.3, dirX, now, { dark: '#0b4a63', body: '#54e8ff', sail: '#d8f8ff', glow: '84,232,255' });
  }
}
