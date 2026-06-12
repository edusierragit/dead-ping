import './styles.css';
import { sfx } from './audio/sound';
import { AiBrain } from './game/ai';
import { createMatch, dashTargets, driftTargets, resolveTurn, torpedoTargets } from './game/rules';
import {
  Action, ActionType, HULL_MAX, MatchState, OCTANTS, PRESSURE_HARD, PRESSURE_SOFT, Rng,
  TurnReport, Vec, coordLabel, eq, mulberry32,
} from './game/types';
import { Scope, emptyView } from './render/scope';
import * as hud from './ui/hud';

const canvas = document.getElementById('scope') as HTMLCanvasElement;
const scope = new Scope(canvas);
let state: MatchState | null = null;
let brain: AiBrain;
let rng: Rng = mulberry32(1);
let busy = true;
let pending: ActionType | null = null;
let enemyKnown = HULL_MAX;

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function loop(now: number) {
  scope.draw(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------- flavor ----------------

const FLAVOR: Record<ActionType, string[]> = {
  drift: ['Dead slow. The hull barely breathes.', 'We slide a few meters through the black.', 'Ballast trimmed. Not a whisper.'],
  dash: ['Full thrust — the screw screams behind us.', 'We run. Everything down here heard it.', 'Cavitation in our wake. Sloppy. Fast.'],
  listen: ['All stop. Hydrophones wide open.', 'We hold our breath and listen.', 'Silence. Just the trench, talking to itself.'],
  ping: ['Active ping away. The whole trench knows us now.', 'One clean pulse. Truth, paid for in noise.'],
  torpedo: ['Tube flooded. Fish away.', 'Launch. The water tears open.'],
  decoy: ['Decoy spinning. Let them hunt a ghost.', 'We leave a liar behind and slip away.'],
};

const MURMUR_LINES = [
  'Transient near %s. Could be nothing. Could be teeth.',
  'Something whispered near %s.',
  'Faint contact, %s. The water is lying to someone.',
];

const STRONG_MURMUR_LINES = [
  'Strong transient near %s — a hull groaning under pressure.',
  'Their plates are singing. Near %s.',
];

const fmt = (s: string, v: string) => s.replace('%s', v);

// ---------------- helpers ----------------

function flashVignette() {
  const el = document.getElementById('tremorVignette')!;
  el.classList.add('on');
  window.setTimeout(() => el.classList.remove('on'), 700);
}

function defaultHint() {
  return 'Choose an action — keys 1-6, ESC cancels targeting.';
}

function availability(s: MatchState): Record<ActionType, boolean> {
  const p = s.subs.player;
  const drifts = driftTargets(s.map, p.pos);
  return {
    drift: drifts.length > 0,
    dash: dashTargets(s.map, p.pos).length > 0,
    listen: true,
    ping: true,
    torpedo: p.cooldown === 0,
    decoy: p.decoysLeft > 0 && drifts.length > 0,
  };
}

function refreshHud() {
  if (state) hud.refresh(state, enemyKnown, availability(state));
}

function cancelTargeting() {
  pending = null;
  scope.targets = null;
  hud.setSelected(null);
  if (!busy) hud.hint(defaultHint());
}

// ---------------- turn flow ----------------

function selectAction(t: ActionType) {
  if (busy || !state) return;
  if (pending === t) {
    cancelTargeting();
    return;
  }
  const s = state;
  const p = s.subs.player;
  if (!availability(s)[t]) return;
  sfx.click();
  if (t === 'listen') return commit({ type: 'listen' });
  if (t === 'ping') return commit({ type: 'ping' });
  let cells: Vec[] = [];
  if (t === 'drift' || t === 'decoy') cells = driftTargets(s.map, p.pos);
  if (t === 'dash') cells = dashTargets(s.map, p.pos);
  if (t === 'torpedo') cells = torpedoTargets(p.pos);
  pending = t;
  scope.targets = { cells, kind: t === 'torpedo' ? 'fire' : 'move' };
  hud.setSelected(t);
  hud.hint({
    drift: 'Click a cell: silent drift.',
    dash: 'Click a cell: loud dash — cavitation marks your origin.',
    torpedo: 'Click a target. 2 dmg direct, 1 splash. Firing screams your position.',
    decoy: 'The decoy drops HERE. Click where to slip away.',
  }[t as 'drift' | 'dash' | 'torpedo' | 'decoy']);
}

function commit(action: Action) {
  if (!state || busy) return;
  busy = true;
  pending = null;
  scope.targets = null;
  hud.setSelected(null);
  hud.hint('');
  const enemyAction = brain.decide(state, rng);
  const report = resolveTurn(state, { player: action, enemy: enemyAction }, rng);
  brain.observe(state, report);
  playReport(report);
}

function playReport(r: TurnReport) {
  const s = state!;
  const now = performance.now();

  const myMove = r.moves.find(m => m.side === 'player');
  if (myMove && !eq(myMove.from, myMove.to)) {
    scope.view.subAnim = { from: myMove.from, to: myMove.to, start: now, dur: 260 };
    scope.view.facing = Math.atan2(myMove.to.y - myMove.from.y, myMove.to.x - myMove.from.x);
  }

  const pa = r.actions.player;
  hud.log(pick(FLAVOR[pa.type]), 'me');
  if (pa.type === 'dash') sfx.whoosh();
  if (pa.type === 'ping') {
    sfx.ping();
    scope.fx.push({ kind: 'ping', pos: { ...s.subs.player.pos }, start: now, dur: 1400 });
  }
  if (pa.type === 'torpedo') sfx.launch();
  if (pa.type === 'decoy') sfx.click();

  const T = (ms: number, fn: () => void) => window.setTimeout(fn, ms);

  // what we heard
  T(380, () => {
    let murmured = false;
    for (const c of r.contacts) {
      if (c.perceiver !== 'player') continue;
      scope.view.contacts.push({ ...c.bloom });
      scope.fx.push({ kind: 'ripple', pos: { ...c.bloom.pos }, start: performance.now(), dur: 900, big: c.bloom.intensity >= 2 });
      if (c.bloom.kind === 'murmur') {
        if (!murmured) {
          sfx.murmur();
          murmured = true;
        }
        if (!c.nearVent) {
          const lines = c.bloom.intensity >= 2 ? STRONG_MURMUR_LINES : MURMUR_LINES;
          hud.log(fmt(pick(lines), coordLabel(c.bloom.pos)), 'contact');
        }
      } else if (c.bloom.kind === 'cavitation') {
        sfx.murmur();
        hud.log(`Cavitation burst at ${coordLabel(c.bloom.pos)} — something ran.`, 'contact');
      } else if (r.actions.enemy.type === 'ping') {
        sfx.alarm();
        hud.log(`ACTIVE SONAR from ${coordLabel(c.bloom.pos)} — THEY HAVE OUR POSITION.`, 'alert');
        flashVignette();
      } else if (r.actions.enemy.type === 'torpedo') {
        hud.log(`Launch transient at ${coordLabel(c.bloom.pos)}!`, 'alert');
      }
    }
  });

  // torpedoes in the water
  if (r.explosions.length) {
    T(620, () => {
      for (const ex of r.explosions) {
        scope.fx.push({
          kind: 'trail',
          pos: { ...ex.target },
          from: { ...s.subs[ex.side].pos },
          start: performance.now(),
          dur: 450,
        });
      }
    });
    T(950, () => {
      for (const ex of r.explosions) {
        const big = ex.oppDamage > 0;
        scope.fx.push({ kind: 'explosion', pos: { ...ex.target }, start: performance.now(), dur: 1000, big });
        scope.addShake(big ? 10 : 6, 500);
        sfx.explosion(big);
        if (ex.side === 'player') {
          if (ex.oppDamage === 2) hud.log('DIRECT HIT. Their hull cracked open.', 'good');
          else if (ex.oppDamage === 1) hud.log('Splash damage — we clipped them.', 'good');
          else hud.log(`Detonation at ${coordLabel(ex.target)}. The deep swallowed it. Miss.`, 'me');
          enemyKnown = Math.max(0, enemyKnown - ex.oppDamage);
        }
      }
      const pd = r.damage.filter(d => d.side === 'player').reduce((acc, d) => acc + d.amount, 0);
      if (pd > 0) {
        hud.log(`WE'RE HIT — hull at ${s.subs.player.hull}/${HULL_MAX}.`, 'alert');
        flashVignette();
      } else if (r.explosions.some(e => e.side === 'enemy')) {
        hud.log("They're shooting at shadows.", 'contact');
      }
      refreshHud();
    });
  }

  // sonar truths
  T(1150, () => {
    for (const rv of r.reveals) {
      if (rv.perceiver !== 'player') continue;
      scope.view.lastKnown = { pos: { ...rv.pos }, turn: r.turn };
      scope.fx.push({ kind: 'reveal', pos: { ...rv.pos }, start: performance.now(), dur: 900 });
      sfx.echoReturn();
      hud.log(`Solid return — CONTACT AT ${coordLabel(rv.pos)}.`, 'good');
    }
    for (const b of r.bearings) {
      if (b.perceiver !== 'player') continue;
      scope.view.bearing = { octant: b.octant, close: b.close, turn: r.turn };
      hud.log(`Hydrophone: contact bearing ${OCTANTS[b.octant]}${b.close ? ' — CLOSE' : ''}.`, 'good');
    }
  });

  // dread
  T(1300, () => {
    if (r.tremor && !s.result) {
      sfx.tremor();
      flashVignette();
      hud.log('PROXIMITY TREMOR — it is right on top of us.', 'alert');
    }
    if (r.turn === PRESSURE_SOFT) {
      sfx.alarm();
      hud.log('The abyss stirs. Hulls are starting to leak sound.', 'alert');
    }
    if (r.turn === PRESSURE_HARD) {
      sfx.alarm();
      hud.log('CRUSH DEPTH RESONANCE — every hull sings its true position.', 'alert');
    }
  });

  // wrap up
  T(1500, () => {
    scope.view.contacts = scope.view.contacts.filter(c => s.turn - c.turn <= 4);
    refreshHud();
    if (s.result) {
      T(900, showEnd);
    } else {
      busy = false;
      hud.hint(defaultHint());
    }
  });
}

// ---------------- screens ----------------

function startMatch() {
  rng = mulberry32(((Date.now() % 2147483647) ^ Math.floor(Math.random() * 1e9)) >>> 0);
  state = createMatch(rng);
  brain = new AiBrain('enemy', state);
  scope.state = state;
  scope.view = emptyView();
  scope.fx = [];
  enemyKnown = HULL_MAX;
  hud.clearLog();
  hud.hideOverlay();
  hud.log('Dive checklist complete. Reactor at whisper.', 'me');
  hud.log('Somewhere in this trench, another hunter just heard our splash.', 'contact');
  hud.log('Find them. Quietly.', 'me');
  refreshHud();
  busy = false;
  hud.hint(defaultHint());
}

function showTitle() {
  hud.showOverlay(`
    <div class="screen">
      <h1 class="title">DEAD PING</h1>
      <p class="tag">Silence is armor. Sound is a confession.</p>
      <p class="lore">Somewhere in this trench there is another hunter-killer.<br/>
      Neither of you can see. Both of you can hear.</p>
      <div class="howto">
        <div><b>DRIFT</b> move 1 cell — silent</div>
        <div><b>DASH</b> move 2-3 straight — leaves cavitation at your origin</div>
        <div><b>LISTEN</b> hold still — hear their bearing</div>
        <div><b>PING</b> see their exact cell — they hear exactly where you are</div>
        <div><b>TORPEDO</b> blast a cell ≤4 away — 2 dmg direct, 1 splash — loud</div>
        <div><b>DECOY</b> drop fake noise and slip away — ×2 per dive</div>
      </div>
      <p class="lore dim">Amber blooms are sound. Some are the enemy. Some are vents. Some are lies.<br/>
      After turn 12 the abyss itself betrays you both. Hull: 4. Silence them first.</p>
      <button id="diveBtn" class="big">▶ DIVE</button>
    </div>
  `);
  document.getElementById('diveBtn')!.addEventListener('click', () => {
    sfx.ensure();
    sfx.drone();
    startMatch();
  });
}

function showEnd() {
  const s = state!;
  const res = s.result!;
  const p = s.subs.player;
  const win = res.winner === 'player';
  const title = win ? 'CONTACT SILENCED'
    : res.winner === 'enemy' ? 'HULL BREACH — ALL HANDS'
    : res.reason === 'mutual' ? 'MUTUAL ANNIHILATION'
    : 'THE ABYSS CLAIMS BOTH';
  const sub = win ? 'The deep keeps what it kills.'
    : res.winner === 'enemy' ? 'Your last sound was the loudest.'
    : 'Two echoes, fading together.';
  const rank = win
    ? (p.noise <= 5 && p.hull === HULL_MAX ? 'APEX PREDATOR' : p.noise <= 8 ? 'SILENT DEATH' : 'HUNTER')
    : res.winner === 'draw' ? 'GHOST' : 'PREY';
  const acc = p.shots > 0 ? Math.round(100 * p.hits / p.shots) : 0;
  sfx.stinger(win);
  hud.showOverlay(`
    <div class="screen">
      <h1 class="title" style="font-size:38px; ${win ? '' : 'color:var(--red); text-shadow:0 0 30px rgba(255,87,71,.5);'}">${title}</h1>
      <p class="tag">${sub}</p>
      <div class="stats">
        <div><b>${s.turn}</b><span>TURNS</span></div>
        <div><b>${p.shots}</b><span>TORPEDOES</span></div>
        <div><b>${acc}%</b><span>ACCURACY</span></div>
        <div><b>${p.noise}</b><span>NOISE MADE</span></div>
        <div><b>${p.hull}/${HULL_MAX}</b><span>HULL LEFT</span></div>
        <div><b>${p.decoysLeft}</b><span>DECOYS LEFT</span></div>
      </div>
      <div class="rank">RATING: ${rank}</div>
      <button id="againBtn" class="big">▶ ONE MORE DIVE</button>
    </div>
  `);
  document.getElementById('againBtn')!.addEventListener('click', startMatch);
}

// ---------------- input ----------------

canvas.addEventListener('click', e => {
  if (!state || busy || !pending) return;
  const cell = scope.cellAt(e.clientX, e.clientY);
  if (!cell || !scope.targets?.cells.some(v => eq(v, cell))) {
    cancelTargeting();
    return;
  }
  const t = pending;
  if (t === 'drift') commit({ type: 'drift', to: cell });
  else if (t === 'dash') commit({ type: 'dash', to: cell });
  else if (t === 'decoy') commit({ type: 'decoy', to: cell });
  else if (t === 'torpedo') commit({ type: 'torpedo', target: cell });
});

canvas.addEventListener('mousemove', e => {
  scope.hover = scope.cellAt(e.clientX, e.clientY);
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    cancelTargeting();
    return;
  }
  const a = hud.ACTIONS.find(x => x.key === e.key);
  if (a) selectAction(a.type);
});

hud.init({ onAction: selectAction });
showTitle();
