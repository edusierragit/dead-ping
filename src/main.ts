import './styles.css';
import { sfx } from './audio/sound';
import { AiBrain } from './game/ai';
import { createMatch, dashTargets, driftTargets, resolveTurn, torpedoTargets } from './game/rules';
import {
  Action, ActionType, HULL_MAX, MatchState, OCTANTS, PRESSURE_HARD, PRESSURE_SOFT, Rng, Side,
  TurnReport, Vec, coordLabel, eq, mulberry32, other,
} from './game/types';
import { NetSession, createSession, genCode } from './net/net';
import { Scope, emptyView } from './render/scope';
import * as hud from './ui/hud';
import { loadLogbook, logbookLine, recordMatch } from './ui/stats';

type Mode = 'ai' | 'online';

const canvas = document.getElementById('scope') as HTMLCanvasElement;
const scope = new Scope(canvas);
let state: MatchState | null = null;
let brain: AiBrain | null = null;
let sharedRng: Rng = mulberry32(1);
let mode: Mode = 'ai';
let mySide: Side = 'player';
let busy = true;
let pending: ActionType | null = null;
let enemyKnown = HULL_MAX;
let matchRecorded = false;
let net: NetSession | null = null;
let localAction: Action | null = null;
let remoteAction: { turn: number; action: Action } | null = null;
let joinTimeout = 0;

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function loop(now: number) {
  scope.draw(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------- narración ----------------

const FLAVOR: Record<ActionType, string[]> = {
  drift: ['Máquina a paso muerto. El casco apenas respira.', 'Nos deslizamos unos metros en la negrura.', 'Lastre ajustado. Ni un susurro.'],
  dash: ['¡A toda máquina! La hélice grita atrás nuestro.', 'Corremos. Todo acá abajo nos escuchó.', 'Cavitación en la estela. Sucio, pero rápido.'],
  listen: ['Todo detenido. Hidrófonos bien abiertos.', 'Contenemos la respiración y escuchamos.', 'Silencio. Solo la fosa, hablando sola.'],
  ping: ['Ping activo. Ahora toda la fosa sabe quiénes somos.', 'Un pulso limpio. La verdad se paga con ruido.'],
  torpedo: ['Tubo inundado. Pez en el agua.', 'Lanzamiento. El agua se desgarra.'],
  decoy: ['Señuelo girando. Que persigan un fantasma.', 'Dejamos un mentiroso atrás y nos esfumamos.'],
};

const MURMUR_LINES = [
  'Transitorio cerca de %s. Puede ser nada. Pueden ser dientes.',
  'Algo susurró cerca de %s.',
  'Contacto débil en %s. El agua le está mintiendo a alguien.',
];

const STRONG_MURMUR_LINES = [
  'Transitorio fuerte cerca de %s — un casco gimiendo por la presión.',
  'Sus planchas están cantando. Cerca de %s.',
];

const fmt = (s: string, v: string) => s.replace('%s', v);

// ---------------- helpers ----------------

function flashVignette() {
  const el = document.getElementById('tremorVignette')!;
  el.classList.add('on');
  window.setTimeout(() => el.classList.remove('on'), 700);
}

function defaultHint() {
  return 'Elegí una acción — teclas 1-6, ESC cancela.';
}

function availability(s: MatchState): Record<ActionType, boolean> {
  const p = s.subs[mySide];
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
  if (state) hud.refresh(state, mySide, enemyKnown, availability(state));
}

function cancelTargeting() {
  pending = null;
  scope.targets = null;
  hud.setSelected(null);
  if (!busy) hud.hint(defaultHint());
}

function leaveNet() {
  if (joinTimeout) {
    window.clearTimeout(joinTimeout);
    joinTimeout = 0;
  }
  if (net) {
    try { net.leave(); } catch { /* already closed */ }
    net = null;
  }
}

// ---------------- flujo de turno ----------------

function selectAction(t: ActionType) {
  if (busy || !state) return;
  if (pending === t) {
    cancelTargeting();
    return;
  }
  const s = state;
  const p = s.subs[mySide];
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
    drift: 'Clic en una celda: deriva silenciosa.',
    dash: 'Clic en una celda: acelerón ruidoso — la cavitación marca tu origen.',
    torpedo: 'Clic en el blanco. 2 daño directo, 1 de onda. Disparar grita tu posición.',
    decoy: 'El señuelo cae ACÁ. Clic en la celda a la que te escabullís.',
  }[t as 'drift' | 'dash' | 'torpedo' | 'decoy']);
}

function commit(action: Action) {
  if (!state || busy) return;
  busy = true;
  pending = null;
  scope.targets = null;
  hud.setSelected(null);
  if (mode === 'online') {
    localAction = action;
    net?.sendAction(state.turn + 1, action);
    if (remoteAction && remoteAction.turn === state.turn + 1) {
      resolveNet();
    } else {
      hud.hint('— esperando al otro cazador —');
    }
    return;
  }
  hud.hint('— resolviendo —');
  const enemyAction = brain!.decide(state, sharedRng);
  const report = resolveTurn(state, { player: action, enemy: enemyAction }, sharedRng);
  brain!.observe(state, report);
  playReport(report);
}

function resolveNet() {
  if (!state || !localAction || !remoteAction) return;
  const actions: Record<Side, Action> = mySide === 'player'
    ? { player: localAction, enemy: remoteAction.action }
    : { player: remoteAction.action, enemy: localAction };
  localAction = null;
  remoteAction = null;
  hud.hint('— resolviendo —');
  const report = resolveTurn(state, actions, sharedRng);
  playReport(report);
}

function playReport(r: TurnReport) {
  const s = state!;
  const now = performance.now();
  const MY = mySide;
  const THEIR = other(MY);

  const myMove = r.moves.find(m => m.side === MY);
  if (myMove && !eq(myMove.from, myMove.to)) {
    scope.view.subAnim = { from: myMove.from, to: myMove.to, start: now, dur: 260 };
    scope.view.facing = Math.atan2(myMove.to.y - myMove.from.y, myMove.to.x - myMove.from.x);
  }

  const pa = r.actions[MY];
  hud.log(pick(FLAVOR[pa.type]), 'me');
  if (pa.type === 'dash') sfx.whoosh();
  if (pa.type === 'ping') {
    sfx.ping();
    scope.fx.push({ kind: 'ping', pos: { ...s.subs[MY].pos }, start: now, dur: 1400 });
  }
  if (pa.type === 'torpedo') sfx.launch();
  if (pa.type === 'decoy') sfx.click();

  const T = (ms: number, fn: () => void) => window.setTimeout(fn, ms);

  // lo que escuchamos
  T(380, () => {
    let murmured = false;
    for (const c of r.contacts) {
      if (c.perceiver !== MY) continue;
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
        hud.log(`Estallido de cavitación en ${coordLabel(c.bloom.pos)} — algo salió corriendo.`, 'contact');
      } else if (r.actions[THEIR].type === 'ping') {
        sfx.alarm();
        hud.log(`SONAR ACTIVO desde ${coordLabel(c.bloom.pos)} — TIENEN NUESTRA POSICIÓN.`, 'alert');
        flashVignette();
      } else if (r.actions[THEIR].type === 'torpedo') {
        hud.log(`¡Transitorio de lanzamiento en ${coordLabel(c.bloom.pos)}!`, 'alert');
      }
    }
  });

  // torpedos en el agua
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
        if (ex.side === MY) {
          if (ex.oppDamage === 2) hud.log('IMPACTO DIRECTO. Su casco se partió.', 'good');
          else if (ex.oppDamage === 1) hud.log('Daño de onda — lo rozamos.', 'good');
          else hud.log(`Detonación en ${coordLabel(ex.target)}. Se lo tragó el abismo. Erramos.`, 'me');
          enemyKnown = Math.max(0, enemyKnown - ex.oppDamage);
        }
      }
      const pd = r.damage.filter(d => d.side === MY).reduce((acc, d) => acc + d.amount, 0);
      if (pd > 0) {
        hud.log(`NOS DIERON — casco en ${s.subs[MY].hull}/${HULL_MAX}.`, 'alert');
        flashVignette();
      } else if (r.explosions.some(e => e.side === THEIR)) {
        hud.log('Le están tirando a las sombras.', 'contact');
      }
      refreshHud();
    });
  }

  // verdades del sonar
  T(1150, () => {
    for (const rv of r.reveals) {
      if (rv.perceiver !== MY) continue;
      scope.view.lastKnown = { pos: { ...rv.pos }, turn: r.turn };
      scope.fx.push({ kind: 'reveal', pos: { ...rv.pos }, start: performance.now(), dur: 900 });
      sfx.echoReturn();
      hud.log(`Retorno sólido — CONTACTO EN ${coordLabel(rv.pos)}.`, 'good');
    }
    for (const b of r.bearings) {
      if (b.perceiver !== MY) continue;
      scope.view.bearing = { octant: b.octant, close: b.close, turn: r.turn };
      hud.log(`Hidrófono: contacto rumbo ${OCTANTS[b.octant]}${b.close ? ' — CERCA' : ''}.`, 'good');
    }
  });

  // el miedo
  T(1300, () => {
    if (r.tremor && !s.result) {
      sfx.tremor();
      flashVignette();
      hud.log('TEMBLOR DE PROXIMIDAD — lo tenemos encima.', 'alert');
    }
    if (r.turn === PRESSURE_SOFT) {
      sfx.alarm();
      hud.log('El abismo se despierta. Los cascos empiezan a filtrar sonido.', 'alert');
    }
    if (r.turn === PRESSURE_HARD) {
      sfx.alarm();
      hud.log('RESONANCIA DE PROFUNDIDAD — cada casco canta su posición exacta.', 'alert');
    }
  });

  // cierre
  T(1500, () => {
    scope.view.contacts = scope.view.contacts.filter(c => s.turn - c.turn <= 4);
    refreshHud();
    if (s.result) {
      if (!matchRecorded) {
        matchRecorded = true;
        const outcome = s.result.winner === mySide ? 'win' : s.result.winner === 'draw' ? 'draw' : 'loss';
        recordMatch(outcome, s.subs[mySide].shots, s.subs[mySide].hits, mode === 'online');
      }
      T(900, showEnd);
    } else {
      busy = false;
      hud.hint(defaultHint());
    }
  });
}

// ---------------- partidas ----------------

function startMatch(seed: number, side: Side, online: boolean) {
  mode = online ? 'online' : 'ai';
  mySide = side;
  sharedRng = mulberry32(seed >>> 0);
  state = createMatch(sharedRng);
  brain = online ? null : new AiBrain('enemy', state);
  localAction = null;
  remoteAction = null;
  scope.state = state;
  scope.mySide = side;
  scope.view = emptyView();
  scope.fx = [];
  enemyKnown = HULL_MAX;
  matchRecorded = false;
  hud.clearLog();
  hud.hideOverlay();
  hud.log('Chequeo de inmersión completo. Reactor en susurro.', 'me');
  if (online) {
    hud.log('Hay otro humano en esta fosa. Peor todavía: te está buscando.', 'contact');
  } else {
    hud.log('En algún lugar de esta fosa, otro cazador escuchó nuestra zambullida.', 'contact');
  }
  hud.log('Encontralo. En silencio.', 'me');
  refreshHud();
  busy = false;
  hud.hint(defaultHint());
}

function newSeed(): number {
  return ((Date.now() % 2147483647) ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

// ---------------- online ----------------

function hostGame() {
  leaveNet();
  const code = genCode();
  net = createSession(code, true);
  wireNet(net);
  hud.showOverlay(`
    <div class="screen">
      <p class="tag">DUELO ONLINE</p>
      <div class="roomCode" id="roomCode">${code}</div>
      <p class="lore">Pasale este código al otro cazador.<br/>La inmersión arranca sola cuando se conecte.</p>
      <p class="lore dim pulse">— esperando en la oscuridad —</p>
      <button id="cancelBtn" class="mid">CANCELAR</button>
    </div>
  `);
  document.getElementById('cancelBtn')!.addEventListener('click', () => {
    leaveNet();
    showTitle();
  });
  net.onJoin(() => {
    if (!net || (state && mode === 'online' && !state.result)) return;
    const seed = newSeed();
    net.sendInit(seed);
    startMatch(seed, 'player', true);
  });
}

function joinGame(code: string) {
  if (code.length !== 4) return;
  leaveNet();
  net = createSession(code, false);
  wireNet(net);
  net.onInit(seed => {
    if (joinTimeout) {
      window.clearTimeout(joinTimeout);
      joinTimeout = 0;
    }
    startMatch(seed, 'enemy', true);
  });
  hud.showOverlay(`
    <div class="screen">
      <p class="tag">DUELO ONLINE</p>
      <div class="roomCode">${code}</div>
      <p class="lore dim pulse">— buscando la sala en la fosa —</p>
      <button id="cancelBtn" class="mid">CANCELAR</button>
    </div>
  `);
  document.getElementById('cancelBtn')!.addEventListener('click', () => {
    leaveNet();
    showTitle();
  });
  joinTimeout = window.setTimeout(() => {
    if (net && !state) {
      leaveNet();
      netError('No encontramos esa sala. Revisá el código o probá de nuevo.');
    }
  }, 30000);
}

function wireNet(session: NetSession) {
  session.onAction((turn, action) => {
    if (!state || state.result) return;
    remoteAction = { turn, action };
    if (localAction && turn === state.turn + 1) resolveNet();
  });
  session.onLeave(() => {
    if (mode === 'online' && state && !state.result) {
      netError('Se cortó la señal. El otro cazador desapareció en la oscuridad.');
    }
  });
}

function netError(msg: string) {
  busy = true;
  leaveNet();
  hud.showOverlay(`
    <div class="screen">
      <p class="tag">SEÑAL PERDIDA</p>
      <p class="lore">${msg}</p>
      <button id="backBtn" class="big">VOLVER AL PUERTO</button>
    </div>
  `);
  document.getElementById('backBtn')!.addEventListener('click', showTitle);
}

// ---------------- pantallas ----------------

function showTitle() {
  busy = true;
  state = null;
  scope.state = null;
  hud.showOverlay(`
    <div class="screen">
      <h1 class="title">DEAD PING</h1>
      <p class="tag">El silencio es blindaje. El sonido es una confesión.</p>
      <p class="lore">En algún lugar de esta fosa hay otro cazador.<br/>
      Ninguno de los dos puede ver. Los dos pueden oír.</p>
      <div class="howto">
        <div><b>DERIVA</b> moverse 1 casilla — silencio total</div>
        <div><b>ACELERÓN</b> moverse 2-3 en línea — deja cavitación en tu origen</div>
        <div><b>ESCUCHAR</b> quedarse quieto — oís el rumbo del enemigo</div>
        <div><b>PING</b> ves su casilla exacta — ellos escuchan la tuya</div>
        <div><b>TORPEDO</b> volás una casilla a ≤4 — 2 daño directo, 1 de onda</div>
        <div><b>SEÑUELO</b> ruido falso y te escabullís — ×2 por inmersión</div>
      </div>
      <p class="lore dim">Las flores ámbar son sonido. Algunas son el enemigo. Otras son vents térmicos. Otras, mentiras.<br/>
      Del turno 12 el abismo los delata a los dos. Casco: 4. Silencialo primero.</p>
      <p class="lore dim" id="lbLine">${logbookLine(loadLogbook())}</p>
      <button id="diveBtn" class="big">▶ SUMERGIRSE — VS ABISMO</button>
      <div class="netRow">
        <button id="hostBtn" class="mid">CREAR DUELO ONLINE</button>
        <input id="codeInput" maxlength="4" placeholder="CÓDIGO" autocomplete="off" spellcheck="false"/>
        <button id="joinBtn" class="mid">UNIRSE</button>
      </div>
    </div>
  `);
  document.getElementById('diveBtn')!.addEventListener('click', () => {
    sfx.ensure();
    sfx.drone();
    startMatch(newSeed(), 'player', false);
  });
  document.getElementById('hostBtn')!.addEventListener('click', () => {
    sfx.ensure();
    sfx.drone();
    hostGame();
  });
  const input = document.getElementById('codeInput') as HTMLInputElement;
  input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
  const join = () => {
    sfx.ensure();
    sfx.drone();
    joinGame(input.value.trim().toUpperCase());
  };
  document.getElementById('joinBtn')!.addEventListener('click', join);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') join();
  });
}

function showEnd() {
  const s = state!;
  const res = s.result!;
  const p = s.subs[mySide];
  const win = res.winner === mySide;
  const title = win ? 'CONTACTO SILENCIADO'
    : res.winner !== 'draw' ? 'CASCO PERFORADO'
    : res.reason === 'mutual' ? 'ANIQUILACIÓN MUTUA'
    : 'EL ABISMO SE QUEDA CON LOS DOS';
  const sub = win ? 'Lo que mata, la fosa se lo queda.'
    : res.winner !== 'draw' ? 'Tu último sonido fue el más fuerte.'
    : res.reason === 'mutual' ? 'Dos ecos, apagándose juntos.'
    : 'Cincuenta turnos de silencio. Nadie ganó.';
  const rank = win
    ? (p.noise <= 5 && p.hull === HULL_MAX ? 'DEPREDADOR APEX' : p.noise <= 8 ? 'MUERTE SILENCIOSA' : 'CAZADOR')
    : res.winner === 'draw' ? 'FANTASMA' : 'PRESA';
  const acc = p.shots > 0 ? Math.round(100 * p.hits / p.shots) : 0;
  sfx.stinger(win);
  const rematchUi = mode === 'ai'
    ? '<button id="againBtn" class="big">▶ OTRA INMERSIÓN</button>'
    : net?.isHost
      ? '<button id="againBtn" class="big">▶ REVANCHA</button>'
      : '<p class="lore dim pulse">— el anfitrión decide la revancha —</p>';
  hud.showOverlay(`
    <div class="screen">
      <h1 class="title" style="font-size:38px; ${win ? '' : 'color:var(--red); text-shadow:0 0 30px rgba(255,87,71,.5);'}">${title}</h1>
      <p class="tag">${sub}</p>
      <div class="stats">
        <div><b>${s.turn}</b><span>TURNOS</span></div>
        <div><b>${p.shots}</b><span>TORPEDOS</span></div>
        <div><b>${acc}%</b><span>PRECISIÓN</span></div>
        <div><b>${p.noise}</b><span>RUIDO EMITIDO</span></div>
        <div><b>${p.hull}/${HULL_MAX}</b><span>CASCO</span></div>
        <div><b>${p.decoysLeft}</b><span>SEÑUELOS</span></div>
      </div>
      <div class="rank">CALIFICACIÓN: ${rank}</div>
      <p class="lore dim">${logbookLine(loadLogbook())}</p>
      ${rematchUi}
      <div><button id="portBtn" class="mid">VOLVER AL PUERTO</button></div>
    </div>
  `);
  document.getElementById('againBtn')?.addEventListener('click', () => {
    if (mode === 'ai') {
      startMatch(newSeed(), 'player', false);
    } else if (net?.isHost) {
      const seed = newSeed();
      net.sendInit(seed);
      startMatch(seed, 'player', true);
    }
  });
  document.getElementById('portBtn')!.addEventListener('click', () => {
    leaveNet();
    showTitle();
  });
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
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    cancelTargeting();
    return;
  }
  const a = hud.ACTIONS.find(x => x.key === e.key);
  if (a) selectAction(a.type);
});

hud.init({ onAction: selectAction });
showTitle();

// test hooks (driven by scripts/e2e.ts through CDP)
declare global {
  interface Window { __dp?: unknown }
}
window.__dp = {
  get busy() { return busy; },
  get state() { return state; },
  get mySide() { return mySide; },
  get lastKnown() { return scope.view.lastKnown; },
  act(t: ActionType, cell?: Vec): boolean {
    if (busy || !state) return false;
    if (t === 'listen' || t === 'ping') {
      commit({ type: t });
      return true;
    }
    if (!cell) return false;
    if (t === 'drift') commit({ type: 'drift', to: cell });
    else if (t === 'dash') commit({ type: 'dash', to: cell });
    else if (t === 'decoy') commit({ type: 'decoy', to: cell });
    else if (t === 'torpedo') commit({ type: 'torpedo', target: cell });
    return true;
  },
};
