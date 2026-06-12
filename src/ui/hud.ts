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

const $ = (id: string) => document.getElementById(id)!;
let onAction: (t: ActionType) => void = () => {};

export function init(cb: { onAction: (t: ActionType) => void }) {
  onAction = cb.onAction;
  const box = $('actions');
  for (const a of ACTIONS) {
    const b = document.createElement('button');
    b.className = 'action';
    b.id = `act-${a.type}`;
    b.innerHTML = `<span class="k">[${a.key}] ${noiseDots(a.noise)}</span><span class="n"><i>${a.icon}</i> ${a.name}</span><span class="d">${a.desc}</span>`;
    b.addEventListener('click', () => onAction(a.type));
    box.appendChild(b);
  }
}

export function setSelected(t: ActionType | null) {
  for (const a of ACTIONS) {
    $(`act-${a.type}`).classList.toggle('sel', a.type === t);
  }
}

function pips(el: HTMLElement, val: number) {
  el.innerHTML = '';
  for (let i = 0; i < HULL_MAX; i++) {
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
  const cd = state.subs[mySide].cooldown;
  const tube = $('tubeLabel');
  tube.textContent = cd > 0 ? `RECARGA [${cd}]` : 'TUBO LISTO';
  tube.className = cd > 0 ? 'warn' : 'ok';
  const dc = state.subs[mySide].decoysLeft;
  $('decoyLabel').textContent = 'SEÑUELOS ' + '◆'.repeat(dc) + '◇'.repeat(2 - dc);
  for (const a of ACTIONS) {
    ($(`act-${a.type}`) as HTMLButtonElement).disabled = !avail[a.type];
  }
}

export function hint(text: string) {
  $('hint').textContent = text;
}

export function setMode(text: string) {
  $('modeLabel').textContent = text;
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
