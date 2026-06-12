import { ActionType, HULL_MAX, MatchState, PRESSURE_HARD, PRESSURE_SOFT, Side } from '../game/types';

export const ACTIONS: { type: ActionType; key: string; name: string; desc: string }[] = [
  { type: 'drift', key: '1', name: 'DERIVA', desc: 'moverse 1 · silencioso' },
  { type: 'dash', key: '2', name: 'ACELERÓN', desc: 'moverse 2-3 recto · ruidoso' },
  { type: 'listen', key: '3', name: 'ESCUCHAR', desc: 'quieto · oís su rumbo' },
  { type: 'ping', key: '4', name: 'PING', desc: 'lo ves exacto · te escuchan' },
  { type: 'torpedo', key: '5', name: 'TORPEDO', desc: 'disparo ≤4 · recarga 3 turnos' },
  { type: 'decoy', key: '6', name: 'SEÑUELO', desc: 'ruido falso · te escabullís' },
];

const $ = (id: string) => document.getElementById(id)!;
let onAction: (t: ActionType) => void = () => {};

export function init(cb: { onAction: (t: ActionType) => void }) {
  onAction = cb.onAction;
  const box = $('actions');
  for (const a of ACTIONS) {
    const b = document.createElement('button');
    b.className = 'action';
    b.id = `act-${a.type}`;
    b.innerHTML = `<span class="k">[${a.key}]</span><span class="n">${a.name}</span><span class="d">${a.desc}</span>`;
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

export function log(text: string, cls = '') {
  const box = $('log');
  const div = document.createElement('div');
  div.textContent = text;
  if (cls) div.className = cls;
  box.appendChild(div);
  while (box.children.length > 80) box.removeChild(box.firstChild!);
  box.scrollTop = box.scrollHeight;
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
