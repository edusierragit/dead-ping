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

const SIZE = 860;
const PAD = 34;
const CS = (SIZE - PAD * 2) / GRID;

export function emptyView(): View {
  return { contacts: [], lastKnown: null, bearing: null, subAnim: null, facing: -Math.PI / 2 };
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

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
    const r = this.canvas.getBoundingClientRect();
    const x = (clientX - r.left) * (SIZE / r.width) - PAD;
    const y = (clientY - r.top) * (SIZE / r.height) - PAD;
    const v = { x: Math.floor(x / CS), y: Math.floor(y / CS) };
    return v.x >= 0 && v.x < GRID && v.y >= 0 && v.y < GRID ? v : null;
  }

  center(v: Vec) {
    return { x: PAD + (v.x + 0.5) * CS, y: PAD + (v.y + 0.5) * CS };
  }

  addShake(mag: number, dur: number) {
    this.shake = { until: performance.now() + dur, mag };
  }

  draw(now: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();

    if (now < this.shake.until) {
      const k = (this.shake.until - now) / 500;
      ctx.translate(
        Math.sin(now * 0.11) * this.shake.mag * k,
        Math.cos(now * 0.13) * this.shake.mag * k,
      );
    }

    // abyss background
    const bg = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 60, SIZE / 2, SIZE / 2, SIZE * 0.75);
    bg.addColorStop(0, '#06141a');
    bg.addColorStop(1, '#020608');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // marine snow: slow drifting motes give the water depth
    for (let i = 0; i < 46; i++) {
      const speed = 4 + hash(i * 13) * 10;
      const x = (((hash(i * 3 + 1) * SIZE + now * 0.003 * (hash(i) - 0.5) * 8) % SIZE) + SIZE) % SIZE;
      const y = (((hash(i * 7 + 2) * SIZE + now * speed / 1000) % SIZE) + SIZE) % SIZE;
      ctx.fillStyle = `rgba(160,220,200,${0.03 + hash(i * 17) * 0.07})`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }

    const s = this.state;
    if (!s) {
      ctx.restore();
      return;
    }

    // grid + coordinates
    ctx.strokeStyle = 'rgba(110,255,176,0.09)';
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= GRID; i++) {
      const p = PAD + i * CS;
      ctx.beginPath();
      ctx.moveTo(p, PAD);
      ctx.lineTo(p, SIZE - PAD);
      ctx.moveTo(PAD, p);
      ctx.lineTo(SIZE - PAD, p);
      ctx.stroke();
      if (i < GRID) {
        ctx.fillStyle = 'rgba(110,255,176,0.32)';
        ctx.fillText(String.fromCharCode(65 + i), PAD + (i + 0.5) * CS, PAD * 0.5);
        ctx.fillText(String(i + 1), PAD * 0.5, PAD + (i + 0.5) * CS);
      }
    }

    // sweep (clipped to the grid)
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD, PAD, SIZE - PAD * 2, SIZE - PAD * 2);
    ctx.clip();
    const ang = (now / 6500) * Math.PI * 2;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    for (let i = 0; i < 30; i++) {
      const a = ang - i * 0.02;
      ctx.strokeStyle = `rgba(110,255,176,${0.05 * (1 - i / 30)})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * SIZE, cy + Math.sin(a) * SIZE);
      ctx.stroke();
    }

    // rocks
    for (let i = 0; i < s.map.rock.length; i++) {
      if (!s.map.rock[i]) continue;
      const v = { x: i % GRID, y: Math.floor(i / GRID) };
      const c = this.center(v);
      ctx.beginPath();
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const r = CS * (0.34 + hash(i * 7 + k) * 0.14);
        const px = c.x + Math.cos(a) * r;
        const py = c.y + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#0c1316';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,170,180,0.22)';
      ctx.stroke();
    }

    // thermal vents
    s.map.vents.forEach((v, i) => {
      const c = this.center(v);
      const pulse = 0.5 + 0.5 * Math.sin(now / 400 + i * 1.7);
      const g = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, CS * 0.85);
      g.addColorStop(0, `rgba(255,170,80,${0.12 + 0.12 * pulse})`);
      g.addColorStop(1, 'rgba(255,170,80,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, CS * 0.85, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 3; k++) {
        const t = ((now / 1500) + k / 3 + i * 0.37) % 1;
        ctx.fillStyle = `rgba(255,190,110,${(1 - t) * 0.5})`;
        ctx.beginPath();
        ctx.arc(c.x + Math.sin(t * 9 + k * 2) * 5, c.y + CS * 0.3 - t * CS * 0.9, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // targeting overlay
    if (this.targets) {
      const fire = this.targets.kind === 'fire';
      const col = fire ? '255,87,71' : '110,255,176';
      const pulse = 0.5 + 0.5 * Math.sin(now / 250);
      for (const v of this.targets.cells) {
        const r = this.rect(v);
        ctx.fillStyle = `rgba(${col},${0.07 + 0.05 * pulse})`;
        ctx.fillRect(r.x + 2, r.y + 2, CS - 4, CS - 4);
        ctx.strokeStyle = `rgba(${col},0.4)`;
        ctx.strokeRect(r.x + 2, r.y + 2, CS - 4, CS - 4);
      }
      if (this.hover && this.targets.cells.some(v => v.x === this.hover!.x && v.y === this.hover!.y)) {
        const r = this.rect(this.hover);
        ctx.fillStyle = `rgba(${col},0.25)`;
        ctx.fillRect(r.x + 2, r.y + 2, CS - 4, CS - 4);
        if (fire) {
          for (const n of neighbors(this.hover)) {
            const nr = this.rect(n);
            ctx.fillStyle = `rgba(${col},0.12)`;
            ctx.fillRect(nr.x + 6, nr.y + 6, CS - 12, CS - 12);
          }
        }
      }
    }

    // sound contacts (the heart of the display)
    for (const c of this.view.contacts) {
      const age = s.turn - c.turn;
      const alpha = Math.max(0, 1 - age / 4);
      if (alpha <= 0) continue;
      const p = this.center(c.pos);
      const col = c.kind === 'scream' ? '255,87,71' : '255,180,84';
      const r = CS * (0.16 + 0.09 * c.intensity);
      ctx.fillStyle = `rgba(${col},${alpha * 0.85})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},${alpha * 0.55})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (c.kind === 'cavitation' || c.kind === 'scream') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${alpha * 0.3})`;
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    // last known position (from active ping)
    if (this.view.lastKnown) {
      const age = s.turn - this.view.lastKnown.turn;
      const alpha = Math.max(0, 1 - age / 6);
      if (alpha > 0) {
        const p = this.center(this.view.lastKnown.pos);
        const r = CS * 0.38;
        ctx.strokeStyle = `rgba(255,87,71,${alpha * 0.9})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - r * 0.5, p.y);
        ctx.lineTo(p.x + r * 0.5, p.y);
        ctx.moveTo(p.x, p.y - r * 0.5);
        ctx.lineTo(p.x, p.y + r * 0.5);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,87,71,${alpha * 0.8})`;
        ctx.font = '10px ui-monospace, Consolas, monospace';
        ctx.fillText(`LKP·T-${age}`, p.x, p.y + r + 10);
        ctx.lineWidth = 1;
      }
    }

    // player position (with move animation)
    let pp = this.center(s.subs[this.mySide].pos);
    const anim = this.view.subAnim;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.dur);
      const a = this.center(anim.from);
      const b = this.center(anim.to);
      const e = 1 - (1 - t) * (1 - t);
      pp = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
      if (t >= 1) this.view.subAnim = null;
    }

    // hydrophone bearing wedge
    if (this.view.bearing) {
      const age = s.turn - this.view.bearing.turn;
      const alpha = Math.max(0, 1 - age / 2);
      if (alpha > 0) {
        const a = (this.view.bearing.octant * 45 - 90) * Math.PI / 180;
        const reach = SIZE * 0.42;
        const g = ctx.createRadialGradient(pp.x, pp.y, 8, pp.x, pp.y, reach);
        g.addColorStop(0, `rgba(200,255,160,${alpha * 0.18})`);
        g.addColorStop(1, 'rgba(200,255,160,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y);
        ctx.arc(pp.x, pp.y, reach, a - 0.4, a + 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = `rgba(200,255,160,${alpha * 0.25})`;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y);
        ctx.lineTo(pp.x + Math.cos(a) * reach, pp.y + Math.sin(a) * reach);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // own decoys
    for (const d of s.decoys) {
      if (d.owner !== this.mySide) continue;
      const p = this.center(d.pos);
      ctx.strokeStyle = 'rgba(110,255,176,0.55)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, CS * 0.26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(110,255,176,0.5)';
      ctx.font = '9px ui-monospace, Consolas, monospace';
      ctx.fillText('DCY', p.x, p.y);
    }

    // propeller wake while moving
    if (this.view.subAnim) {
      const dir = this.view.facing;
      for (let k = 1; k <= 4; k++) {
        ctx.fillStyle = `rgba(180,255,220,${0.4 - k * 0.08})`;
        ctx.beginPath();
        ctx.arc(
          pp.x - Math.cos(dir) * (CS * 0.32 + k * 7) + Math.sin(now / 80 + k) * 2,
          pp.y - Math.sin(dir) * (CS * 0.32 + k * 7) + Math.cos(now / 95 + k) * 2,
          2.4 - k * 0.4, 0, Math.PI * 2,
        );
        ctx.fill();
      }
    }

    // the player's boat
    const bob = Math.sin(now / 600) * 1.5;
    this.drawSub(pp.x, pp.y + bob, this.view.facing, {
      dark: '#155c3e', body: '#7dffc0', sail: '#d8ffe9', glow: '110,255,176',
    });

    // hull ticks under the boat: your life, always visible where you look
    const hull = s.subs[this.mySide].hull;
    for (let i = 0; i < HULL_MAX; i++) {
      const tx = pp.x - (HULL_MAX * 9) / 2 + i * 9;
      const ty = pp.y + CS * 0.52;
      if (i < hull) {
        ctx.fillStyle = 'rgba(110,255,176,0.9)';
        ctx.fillRect(tx, ty, 7, 3);
      } else {
        ctx.strokeStyle = 'rgba(110,255,176,0.35)';
        ctx.strokeRect(tx + 0.5, ty + 0.5, 6, 2);
      }
    }

    // enemy revealed only when the match ends
    if (s.result) {
      const ep = this.center(s.subs[other(this.mySide)].pos);
      this.drawSub(ep.x, ep.y, Math.PI / 2, {
        dark: '#6b2218', body: '#ff8a78', sail: '#ffd6cc', glow: '255,87,71',
      });
    }

    // effects
    this.fx = this.fx.filter(f => now - f.start < f.dur);
    for (const f of this.fx) {
      const t = (now - f.start) / f.dur;
      const p = this.center(f.pos);
      if (f.kind === 'ripple') {
        const r = CS * (0.3 + t * (f.big ? 2.2 : 1.5));
        ctx.strokeStyle = `rgba(255,180,84,${(1 - t) * 0.7})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else if (f.kind === 'ping') {
        for (const off of [0, 0.18]) {
          const tt = t - off;
          if (tt <= 0) continue;
          ctx.strokeStyle = `rgba(110,255,176,${(1 - tt) * 0.5})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, tt * SIZE * 0.8, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      } else if (f.kind === 'explosion') {
        const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, CS * (0.5 + t * 1.4));
        g.addColorStop(0, `rgba(255,235,200,${(1 - t) * 0.9})`);
        g.addColorStop(0.4, `rgba(255,140,60,${(1 - t) * 0.6})`);
        g.addColorStop(1, 'rgba(255,87,71,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, CS * (0.5 + t * 1.4), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,180,84,${(1 - t) * 0.8})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, t * CS * (f.big ? 2.6 : 1.8), 0, Math.PI * 2);
        ctx.stroke();
        for (let k = 0; k < 12; k++) {
          const a = k * 2.39996 + f.start;
          const d = t * CS * 1.5 * (0.5 + hash(k + f.start) * 0.5);
          ctx.fillStyle = `rgba(255,200,120,${(1 - t) * 0.8})`;
          ctx.fillRect(p.x + Math.cos(a) * d - 1, p.y + Math.sin(a) * d - 1, 2, 2);
        }
      } else if (f.kind === 'reveal') {
        const r = CS * (1.6 - t * 1.2);
        ctx.strokeStyle = `rgba(255,87,71,${0.4 + t * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else if (f.kind === 'label' && f.text) {
        const rise = t * 20;
        const col = f.color ?? '255,180,84';
        ctx.font = 'bold 17px ui-monospace, Consolas, monospace';
        ctx.shadowColor = `rgba(${col},0.9)`;
        ctx.shadowBlur = 10;
        ctx.fillStyle = `rgba(${col},${Math.max(0, 1 - t * 1.1)})`;
        ctx.fillText(f.text, p.x, p.y - CS * 0.75 - rise);
        ctx.shadowBlur = 0;
        ctx.font = '11px ui-monospace, Consolas, monospace';
      } else if (f.kind === 'trail' && f.from) {
        const a = this.center(f.from);
        const tt = Math.min(1, t / 0.7);
        const mx = a.x + (p.x - a.x) * tt;
        const my = a.y + (p.y - a.y) * tt;
        ctx.strokeStyle = `rgba(255,220,160,${(1 - t) * 0.35})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(mx, my);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,235,200,${1 - t})`;
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore(); // clip
    ctx.restore(); // shake
  }

  private rect(v: Vec) {
    return { x: PAD + v.x * CS, y: PAD + v.y * CS };
  }

  // top-down submarine: teardrop hull, sail, tail fins
  private drawSub(x: number, y: number, facing: number, c: { dark: string; body: string; sail: string; glow: string }) {
    const ctx = this.ctx;
    const L = CS * 0.40;
    const W = CS * 0.15;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(facing + Math.PI / 2);
    ctx.shadowColor = `rgba(${c.glow},0.85)`;
    ctx.shadowBlur = 16;
    const g = ctx.createLinearGradient(-W, 0, W, 0);
    g.addColorStop(0, c.dark);
    g.addColorStop(0.5, c.body);
    g.addColorStop(1, c.dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -L);
    ctx.quadraticCurveTo(W, -L * 0.45, W, 0);
    ctx.quadraticCurveTo(W, L * 0.78, 0, L);
    ctx.quadraticCurveTo(-W, L * 0.78, -W, 0);
    ctx.quadraticCurveTo(-W, -L * 0.45, 0, -L);
    ctx.fill();
    // tail fins
    ctx.shadowBlur = 6;
    ctx.strokeStyle = c.body;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-W * 1.7, L * 0.98);
    ctx.lineTo(0, L * 0.55);
    ctx.lineTo(W * 1.7, L * 0.98);
    ctx.stroke();
    // sail (conning tower)
    ctx.shadowBlur = 0;
    ctx.fillStyle = c.sail;
    ctx.beginPath();
    ctx.ellipse(0, -L * 0.12, W * 0.4, L * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1;
  }
}
