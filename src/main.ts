import './styles.css';
import { sfx } from './audio/sound';
import { AiBrain } from './game/ai';
import { createMatch, dashTargets, driftTargets, resolveTurn, torpedoTargets } from './game/rules';
import {
  Action, ActionType, HULL_MAX, MatchState, OCTANTS, PRESSURE_HARD, PRESSURE_SOFT, Rng, Side,
  TurnReport, Vec, coordLabel, eq, idx, mulberry32, other,
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
let phase: 'deploy' | 'play' = 'play';
let mySpawn: Vec | null = null;
let theirSpawn: Vec | null = null;
let myNoise = 0; // how loud you've been lately (0-3), decays each turn
let myNick = 'CAZADOR';
let theirNick = 'RIVAL';
let roomScore = { me: 0, them: 0 };
try { myNick = localStorage.getItem('deadping.nick') || 'CAZADOR'; } catch { /* ok */ }

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function loop(now: number) {
  scope.draw(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------- microcopy ----------------

const MURMUR_LINES = ['Ruido cerca de %s.', 'Algo se movió cerca de %s.'];
const STRONG_MURMUR_LINES = ['Un casco cruje cerca de %s.'];

const fmt = (s: string, v: string) => s.replace('%s', v);

const GREEN = '84,232,255';
const RED = '255,87,71';
const AMBER = '255,180,84';

function label(text: string, pos: Vec, color: string) {
  scope.fx.push({ kind: 'label', pos: { ...pos }, text, color, start: performance.now(), dur: 1600 });
}

// coach: first dive teaches the loop in three lines, then never again
const COACH = [
  'Movete sin ruido (1). Él tampoco te ve.',
  'ESCUCHAR (3) revela su dirección.',
  'PING (4) lo revela exacto — y te expone.',
];
let coachStep = -1; // -1 = off

// ---------------- helpers ----------------

function flashVignette() {
  const el = document.getElementById('tremorVignette')!;
  el.classList.add('on');
  window.setTimeout(() => el.classList.remove('on'), 700);
}

function defaultHint() {
  return 'UNA acción por turno — teclas 1-6, ESC cancela.';
}

function modeBase() {
  if (mode !== 'online') return 'VS ABISMO';
  return `${myNick} ${roomScore.me}–${roomScore.them} ${theirNick} · ${net?.code ?? ''}`;
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
  if (!state) return;
  const avail = phase === 'play'
    ? availability(state)
    : { drift: false, dash: false, listen: false, ping: false, torpedo: false, decoy: false };
  hud.refresh(state, mySide, enemyKnown, myNoise, avail);
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
  if (busy || !state || phase !== 'play') return;
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
  if (!state || busy || phase !== 'play') return;
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
      hud.setTurnState('waiting');
      hud.hint('');
    }
    return;
  }
  hud.setTurnState('resolving');
  hud.hint('');
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
  hud.setMode(modeBase());
  hud.setTurnState('resolving');
  hud.hint('');
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
  // your noise meter: loud actions spike it, silence drains it
  myNoise = Math.max(0, myNoise - 1);
  if (pa.type === 'dash') myNoise = Math.min(3, myNoise + 2);
  if (pa.type === 'ping' || pa.type === 'torpedo') myNoise = 3;
  if (r.pressure > 0 && (r.turn % 2 === 0) === (MY === 'player')) myNoise = Math.min(3, myNoise + 1);
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
      // vent murmurs are ambient: a faint flicker, never a contact marker.
      // anything amber that STAYS on the board is a real clue.
      if (c.bloom.kind === 'murmur' && c.nearVent) {
        scope.fx.push({ kind: 'ripple', pos: { ...c.bloom.pos }, start: performance.now(), dur: 600, big: false });
        continue;
      }
      scope.view.contacts.push({ ...c.bloom });
      scope.fx.push({ kind: 'ripple', pos: { ...c.bloom.pos }, start: performance.now(), dur: 900, big: c.bloom.intensity >= 2 });
      if (c.bloom.kind === 'murmur') {
        if (!murmured) {
          sfx.murmur();
          murmured = true;
        }
        const lines = c.bloom.intensity >= 2 ? STRONG_MURMUR_LINES : MURMUR_LINES;
        hud.log(fmt(pick(lines), coordLabel(c.bloom.pos)), 'contact');
      } else if (c.bloom.kind === 'cavitation') {
        sfx.murmur();
        hud.log(`Cavitación en ${coordLabel(c.bloom.pos)} — algo corrió.`, 'contact');
      } else if (r.actions[THEIR].type === 'ping') {
        sfx.alarm();
        hud.log('SONAR ENEMIGO — saben dónde estamos.', 'alert');
        label('¡NOS VIERON!', s.subs[MY].pos, RED);
        flashVignette();
      } else if (r.actions[THEIR].type === 'torpedo') {
        hud.log(`Lanzamiento desde ${coordLabel(c.bloom.pos)}.`, 'alert');
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
          if (ex.oppDamage === 2) {
            hud.log('Impacto directo.', 'good');
            label('¡IMPACTO DIRECTO!', ex.target, GREEN);
          } else if (ex.oppDamage === 1) {
            hud.log('Lo rozamos.', 'good');
            label('¡LO ROZAMOS!', ex.target, GREEN);
          } else {
            hud.log(`Erramos en ${coordLabel(ex.target)}.`, 'me');
            label('ERRAMOS', ex.target, AMBER);
          }
          enemyKnown = Math.max(0, enemyKnown - ex.oppDamage);
        }
      }
      const pd = r.damage.filter(d => d.side === MY).reduce((acc, d) => acc + d.amount, 0);
      if (pd > 0) {
        hud.log(`NOS DIERON — casco ${s.subs[MY].hull}/${HULL_MAX}.`, 'alert');
        label('¡NOS DIERON!', s.subs[MY].pos, RED);
        flashVignette();
      } else if (r.explosions.some(e => e.side === THEIR)) {
        hud.log('Le tira a las sombras.', 'contact');
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
      hud.log(`Contacto en ${coordLabel(rv.pos)}.`, 'good');
      label('¡CONTACTO!', rv.pos, RED);
    }
    for (const b of r.bearings) {
      if (b.perceiver !== MY) continue;
      scope.view.bearing = { octant: b.octant, close: b.close, turn: r.turn };
      scope.fx.push({ kind: 'listen', pos: { ...s.subs[MY].pos }, start: performance.now(), dur: 1100 });
      label(`RUMBO ${OCTANTS[b.octant]}${b.close ? ' · CERCA' : ''}`, s.subs[MY].pos, GREEN);
      hud.log(`Rumbo ${OCTANTS[b.octant]}${b.close ? ' — CERCA' : ''}.`, 'good');
    }
  });

  // el miedo
  T(1300, () => {
    if (r.tremor && !s.result) {
      sfx.tremor();
      flashVignette();
      hud.log('Está encima nuestro.', 'alert');
      label('ESTÁ CERCA', s.subs[MY].pos, RED);
    }
    if (r.turn === PRESSURE_SOFT) {
      sfx.alarm();
      hud.log('La fosa despierta: los cascos filtran ruido.', 'alert');
    }
    if (r.turn === PRESSURE_HARD) {
      sfx.alarm();
      hud.log('Resonancia: las posiciones exactas se filtran.', 'alert');
    }
  });

  // cierre
  T(1300, () => {
    scope.view.contacts = scope.view.contacts.filter(c => s.turn - c.turn <= 4);
    refreshHud();
    if (s.result) {
      hud.setTurnState('none');
      if (!matchRecorded) {
        matchRecorded = true;
        const outcome = s.result.winner === mySide ? 'win' : s.result.winner === 'draw' ? 'draw' : 'loss';
        recordMatch(outcome, s.subs[mySide].shots, s.subs[mySide].hits, mode === 'online');
        if (mode === 'online') {
          if (outcome === 'win') roomScore.me++;
          else if (outcome === 'loss') roomScore.them++;
        }
      }
      T(900, showEnd);
    } else {
      busy = false;
      hud.setTurnState('yours');
      if (coachStep >= 0 && coachStep < COACH.length) {
        hud.hint('› ' + COACH[coachStep++]);
        if (coachStep >= COACH.length) {
          try { localStorage.setItem('deadping.coached', '1'); } catch { /* ok */ }
          coachStep = -1;
        }
      } else {
        hud.hint(defaultHint());
      }
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
  myNoise = 0;
  matchRecorded = false;
  hud.clearLog();
  hud.hideOverlay();
  if (online) net?.sendHello(myNick); // re-announce every match so names never miss
  hud.setMode(modeBase());
  hud.log(online ? 'Otro humano anda en la fosa.' : 'Otro cazador anda en la fosa.', 'contact');
  refreshHud();
  // fase de despliegue: elegís tu casilla inicial en secreto
  phase = 'deploy';
  mySpawn = null;
  theirSpawn = null;
  scope.targets = {
    cells: state.zones[mySide].filter(v => !state!.map.rock[idx(v)]),
    kind: 'move',
  };
  busy = false;
  hud.setTurnState('deploy');
  hud.hint('› Clic en tu zona iluminada.');
}

function handleSpawn(cell: Vec) {
  if (!state || phase !== 'deploy' || mySpawn) return;
  mySpawn = { ...cell };
  sfx.click();
  if (mode === 'online') {
    net?.sendSpawn(mySpawn);
    scope.targets = null;
    hud.setTurnState('waiting');
    hud.hint('');
    tryStartPlay();
  } else {
    state.subs[mySide].pos = { ...mySpawn };
    beginPlay();
  }
}

function tryStartPlay() {
  if (!state || phase !== 'deploy' || !mySpawn || !theirSpawn) return;
  state.subs[mySide].pos = { ...mySpawn };
  state.subs[other(mySide)].pos = { ...theirSpawn };
  beginPlay();
}

function beginPlay() {
  if (!state) return;
  phase = 'play';
  scope.targets = null;
  const p = state.subs[mySide].pos;
  scope.view.facing = Math.atan2(5 - p.y, 5 - p.x);
  refreshHud();
  let coached = true;
  try { coached = !!localStorage.getItem('deadping.coached'); } catch { /* ok */ }
  hud.setTurnState('yours');
  if (!coached && mode === 'ai') {
    coachStep = 0;
    hud.hint('› ' + COACH[coachStep++]);
  } else {
    coachStep = -1;
    hud.hint(defaultHint());
  }
}

function newSeed(): number {
  return ((Date.now() % 2147483647) ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

// ---------------- online ----------------

function hostGame() {
  leaveNet();
  roomScore = { me: 0, them: 0 };
  theirNick = 'RIVAL';
  const code = genCode();
  net = createSession(code, true);
  wireNet(net);
  const link = `${location.origin}${location.pathname}?sala=${code}`;
  hud.showOverlay(`
    <div class="screen">
      <p class="tag">DUELO ONLINE</p>
      <div class="roomCode" id="roomCode">${code}</div>
      <p class="lore">Pasale el código — o directamente el link:</p>
      <div class="shareLink">${link}</div>
      <button id="copyBtn" class="mid">COPIAR LINK</button>
      <p class="lore dim pulse">— esperando en la oscuridad —</p>
      <button id="cancelBtn" class="mid">CANCELAR</button>
    </div>
  `);
  document.getElementById('copyBtn')!.addEventListener('click', () => {
    void navigator.clipboard?.writeText(link);
    document.getElementById('copyBtn')!.textContent = 'COPIADO ✓';
  });
  document.getElementById('cancelBtn')!.addEventListener('click', () => {
    leaveNet();
    showTitle();
  });
  net.onJoin(() => {
    if (!net || (state && mode === 'online' && !state.result)) return;
    net.sendHello(myNick);
    const seed = newSeed();
    net.sendInit(seed);
    startMatch(seed, 'player', true);
  });
}

function joinGame(code: string) {
  if (code.length !== 4) return;
  leaveNet();
  roomScore = { me: 0, them: 0 };
  theirNick = 'RIVAL';
  net = createSession(code, false);
  wireNet(net);
  net.onInit(seed => {
    if (joinTimeout) {
      window.clearTimeout(joinTimeout);
      joinTimeout = 0;
    }
    net?.sendHello(myNick);
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
    else if (phase === 'play') hud.setMode(modeBase() + ' · ¡YA MOVIÓ!');
  });
  session.onSpawn(v => {
    theirSpawn = { x: v.x, y: v.y };
    tryStartPlay();
  });
  session.onHello(name => {
    theirNick = name.toUpperCase();
    hud.setMode(modeBase());
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
  hud.setMode('');
  hud.setTurnState('none');
  hud.showOverlay(`
    <div class="screen">
      <h1 class="title">DEAD PING</h1>
      <p class="tag">El ruido te delata.</p>
      <p class="lore">Dos submarinos. Una fosa negra. Un disparo correcto.</p>
      <div class="pillars">
        <div><span class="pic">→</span><b>MOVETE</b><i>en silencio</i></div>
        <div><span class="pic">◉</span><b>ESCUCHÁ</b><i>cada ruido es una pista</i></div>
        <div><span class="pic">⊕</span><b>HUNDILO</b><i>antes de que te oiga</i></div>
      </div>
      <button id="diveBtn" class="big">▶ JUGAR VS IA</button>
      <div class="netRow">
        <input id="nickInput" maxlength="12" placeholder="TU APODO" autocomplete="off" spellcheck="false" value="${myNick === 'CAZADOR' ? '' : myNick}"/>
        <button id="hostBtn" class="mid">CREAR DUELO ONLINE</button>
        <input id="codeInput" maxlength="4" placeholder="CÓDIGO" autocomplete="off" spellcheck="false"/>
        <button id="joinBtn" class="mid">UNIRSE</button>
      </div>
      <p class="lore dim" id="lbLine">${logbookLine(loadLogbook())}</p>
    </div>
  `);
  const nick = document.getElementById('nickInput') as HTMLInputElement;
  nick.addEventListener('input', () => {
    myNick = nick.value.trim().toUpperCase() || 'CAZADOR';
    try { localStorage.setItem('deadping.nick', myNick); } catch { /* ok */ }
  });
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
      ${mode === 'online' ? `<div class="roomScore">${myNick} ${roomScore.me} — ${roomScore.them} ${theirNick}</div>` : ''}
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
  if (!state || busy) return;
  const cell = scope.cellAt(e.clientX, e.clientY);
  if (phase === 'deploy') {
    if (cell && scope.targets?.cells.some(v => eq(v, cell))) handleSpawn(cell);
    return;
  }
  if (!pending) return;
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

// joining by shared link: ?sala=CODE → pick your nick first, then dive
function joinPrompt(code: string) {
  hud.showOverlay(`
    <div class="screen">
      <p class="tag">TE INVITARON A UN DUELO</p>
      <div class="roomCode">${code}</div>
      <p class="lore">¿Cómo te llamás, cazador?</p>
      <div class="netRow">
        <input id="nickInput" maxlength="12" placeholder="TU APODO" autocomplete="off" spellcheck="false" value="${myNick === 'CAZADOR' ? '' : myNick}"/>
      </div>
      <button id="goBtn" class="big">▶ ENTRAR A LA SALA</button>
      <div><button id="cancelBtn" class="mid">CANCELAR</button></div>
    </div>
  `);
  const nick = document.getElementById('nickInput') as HTMLInputElement;
  nick.focus();
  nick.addEventListener('input', () => {
    myNick = nick.value.trim().toUpperCase() || 'CAZADOR';
    try { localStorage.setItem('deadping.nick', myNick); } catch { /* ok */ }
  });
  const go = () => {
    sfx.ensure();
    sfx.drone();
    joinGame(code);
  };
  document.getElementById('goBtn')!.addEventListener('click', go);
  nick.addEventListener('keydown', e => {
    if (e.key === 'Enter') go();
  });
  document.getElementById('cancelBtn')!.addEventListener('click', showTitle);
}

const salaParam = new URLSearchParams(location.search).get('sala');
if (salaParam && salaParam.length === 4) {
  history.replaceState(null, '', location.pathname);
  joinPrompt(salaParam.toUpperCase());
}

// test hooks (driven by scripts/e2e.ts through CDP)
declare global {
  interface Window { __dp?: unknown }
}
window.__dp = {
  get busy() { return busy; },
  get state() { return state; },
  get mySide() { return mySide; },
  get phase() { return phase; },
  get lastKnown() { return scope.view.lastKnown; },
  spawnAt(cell?: Vec) {
    const c = cell ?? scope.targets?.cells[0];
    if (c) handleSpawn(c);
  },
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
