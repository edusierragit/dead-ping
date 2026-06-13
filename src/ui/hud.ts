import { ActionType, HULL_MAX, MatchState, PRESSURE_HARD, PRESSURE_SOFT, Side } from '../game/types';

export const ACTIONS: { type: ActionType; key: string; icon: string; name: string; desc: string; noise: number }[] = [
  { type: 'drift', key: '1', icon: '→', name: 'MOVER', desc: '1 casilla, sin ruido', noise: 0 },
  { type: 'dash', key: '2', icon: '≫', name: 'ACELERAR', desc: '2-3 casillas en línea', noise: 2 },
  { type: 'listen', key: '3', icon: ')))', name: 'ESCUCHAR', desc: 'quieto · oís su dirección', noise: 0 },
  { type: 'ping', key: '4', icon: '◎', name: 'PING', desc: 'lo ves exacto', noise: 3 },
  { type: 'torpedo', key: '5', icon: '⊕', name: 'TORPEDO', desc: 'volá una casilla a ≤4', noise: 3 },
  { type: 'decoy', key: '6', icon: '◌', name: 'SEÑUELO', desc: 'ruido falso · ×2', noise: 0 },
];

function noiseDots(n: number): string {
  if (n === 0) return '<span class="nz quiet">silencio</span>';
  return `<span class="nz loud">ruido ${'●'.repeat(n)}${'○'.repeat(3 - n)}</span>`;
}

// one-line explanations on hover: the curious learn without a manual
const TIPS: Record<ActionType, string> = {
  drift: 'Te movés 1 casilla. Nadie te oye.',
  dash: '2-3 casillas en línea. El enemigo oye tu casilla de SALIDA.',
  listen: 'Te quedás quieto y oís la dirección del enemigo (cono en el mapa).',
  ping: 'Ves su casilla exacta… pero él oye la tuya exacta. Verdad por verdad.',
  torpedo: 'Explota una casilla a ≤4: 2 de daño directo, 1 al lado. Recarga 3 turnos.',
  decoy: 'Dejás un emisor de ruido falso y te movés 1. Solo tenés 2 por partida.',
};

const $ = (id: string) => document.getElementById(id)!;
let onAction: (t: ActionType) => void = () => {};
let onPreview: (t: ActionType | null) => void = () => {};
let onConfirm: () => void = () => {};

export function init(cb: {
  onAction: (t: ActionType) => void;
  onPreview: (t: ActionType | null) => void;
  onConfirm: () => void;
}) {
  onAction = cb.onAction;
  onPreview = cb.onPreview;
  onConfirm = cb.onConfirm;
  const box = $('actions');
  for (const a of ACTIONS) {
    const b = document.createElement('button');
    b.className = 'action';
    b.id = `act-${a.type}`;
    b.innerHTML = `<span class="k">[${a.key}] ${noiseDots(a.noise)}</span><span class="n"><i>${a.icon}</i> ${a.name}</span><span class="d">${a.desc}</span>`;
    b.title = TIPS[a.type];
    b.addEventListener('click', () => onAction(a.type));
    // hover a button to preview its effect on the board — explore without spending a turn
    b.addEventListener('mouseenter', () => onPreview(a.type));
    b.addEventListener('mouseleave', () => onPreview(null));
    box.appendChild(b);
  }
  $('turnState').addEventListener('click', () => onConfirm());
}

export function setSelected(t: ActionType | null) {
  for (const a of ACTIONS) {
    $(`act-${a.type}`).classList.toggle('sel', a.type === t);
  }
}

function pips(el: HTMLElement, val: number, max = HULL_MAX) {
  el.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const s = document.createElement('span');
    if (i < val) s.className = 'full';
    el.appendChild(s);
  }
}

export function refresh(state: MatchState, mySide: Side, enemyKnown: number, avail: Record<ActionType, boolean>) {
  pips($('hullPlayer'), state.subs[mySide].hull);
  pips($('hullEnemy'), enemyKnown);
  $('turnLabel').textContent = `T-${String(state.turn + 1).padStart(2, '0')}`;
  const next = state.turn + 1;
  const pl = $('pressureLabel');
  pl.textContent = next >= PRESSURE_HARD ? 'PRESIÓN: CRÍTICA' : next >= PRESSURE_SOFT ? 'PRESIÓN: SUBIENDO' : '';
  pl.className = next >= PRESSURE_HARD ? 'crit' : next >= PRESSURE_SOFT ? 'warn' : '';
  // resources live ON the action buttons, where the decision happens
  const cd = state.subs[mySide].cooldown;
  const torNz = $('act-torpedo').querySelector('.nz') as HTMLElement;
  if (cd > 0) {
    torNz.textContent = `▮ RECARGA ${cd}`;
    torNz.className = 'nz cd';
  } else {
    torNz.innerHTML = 'ruido ●●●';
    torNz.className = 'nz loud';
  }
  const dc = state.subs[mySide].decoysLeft;
  const decN = $('act-decoy').querySelector('.n') as HTMLElement;
  decN.innerHTML = `<i>◌</i> SEÑUELO <span class="charges">${'◆'.repeat(dc)}${'◇'.repeat(2 - dc)}</span>`;
  for (const a of ACTIONS) {
    ($(`act-${a.type}`) as HTMLButtonElement).disabled = !avail[a.type];
  }
}

// hovering an action ghosts onto the RUIDO meter how loud it would make you
export function previewNoise(level: number | null) {
  const bar = $('noiseBar');
  const spans = Array.from(bar.children) as HTMLElement[];
  spans.forEach((s, i) => {
    s.classList.toggle('ghost', level != null && i < level && !s.classList.contains('full'));
  });
}

export function hint(text: string) {
  $('hint').textContent = text;
}

export function setMode(text: string) {
  $('modeLabel').textContent = text;
}

export type TurnState = 'yours' | 'waiting' | 'resolving' | 'deploy' | 'confirm' | 'none';

export function setTurnState(kind: TurnState, label = '') {
  const el = $('turnState');
  const map: Record<TurnState, [string, string]> = {
    yours: ['▶ TU TURNO — ELEGÍ ACCIÓN', 'ts-yours'],
    waiting: ['⌛ ESPERANDO AL RIVAL…', 'ts-wait'],
    resolving: ['··· RESOLVIENDO ···', 'ts-res'],
    deploy: ['⚓ ELEGÍ TU POSICIÓN INICIAL', 'ts-yours'],
    confirm: [`✓ CONFIRMAR: ${label}  ⏎`, 'ts-confirm'],
    none: ['', 'ts-none'],
  };
  el.textContent = map[kind][0];
  el.className = map[kind][1];
}

// at most two recent events on screen: the board tells the story, not a log
export function log(text: string, cls = '') {
  const box = $('log');
  const div = document.createElement('div');
  div.textContent = text;
  if (cls) div.className = cls;
  box.prepend(div);
  while (box.children.length > 2) box.removeChild(box.lastChild!);
}

export function clearLog() {
  $('log').innerHTML = '';
}

export function showOverlay(html: string) {
  const ov = $('overlay');
  ov.innerHTML = html;
  ov.classList.remove('hidden');
}

export function hideOverlay() {
  $('overlay').classList.add('hidden');
}
