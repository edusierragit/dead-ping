export interface Vec { x: number; y: number }

export const GRID = 11;
export const HULL_MAX = 4;
export const TORPEDO_RANGE = 4;
export const TORPEDO_COOLDOWN = 3;
export const DASH_MIN = 2;
export const DASH_MAX = 3;
export const DECOY_COUNT = 2;
export const DECOY_LIFE = 5;
export const LISTEN_CLOSE = 3;
export const TREMOR_DIST = 2;
export const PRESSURE_SOFT = 12;
export const PRESSURE_HARD = 20;
export const TURN_CAP = 50;

export type Side = 'player' | 'enemy';
export type ActionType = 'drift' | 'dash' | 'ping' | 'torpedo' | 'decoy' | 'listen';

export type Action =
  | { type: 'drift'; to: Vec }
  | { type: 'dash'; to: Vec }
  | { type: 'ping' }
  | { type: 'torpedo'; target: Vec }
  | { type: 'decoy'; to: Vec }
  | { type: 'listen' };

export type BloomKind = 'murmur' | 'cavitation' | 'scream';

export interface Bloom {
  pos: Vec;
  kind: BloomKind;
  intensity: number; // 1..3
  turn: number;
}

export interface SubState {
  pos: Vec;
  hull: number;
  cooldown: number;
  decoysLeft: number;
  shots: number;
  hits: number;
  noise: number;
}

export interface Decoy { owner: Side; pos: Vec; born: number }

export interface GameMap { rock: boolean[]; vents: Vec[] }

export interface Result { winner: Side | 'draw'; reason: 'kill' | 'mutual' | 'abyss' }

export interface MatchState {
  turn: number;
  map: GameMap;
  subs: Record<Side, SubState>;
  decoys: Decoy[];
  zones: Record<Side, Vec[]>;
  result: Result | null;
}

export interface TurnReport {
  turn: number;
  actions: Record<Side, Action>;
  moves: { side: Side; from: Vec; to: Vec }[];
  contacts: { perceiver: Side; bloom: Bloom; nearVent: boolean }[];
  explosions: { side: Side; target: Vec; oppDamage: number }[];
  damage: { side: Side; amount: number }[];
  reveals: { perceiver: Side; pos: Vec }[];
  bearings: { perceiver: Side; octant: number; close: boolean }[];
  tremor: boolean;
  pressure: 0 | 1 | 2;
}

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const other = (s: Side): Side => (s === 'player' ? 'enemy' : 'player');
export const idx = (v: Vec) => v.y * GRID + v.x;
export const inGrid = (v: Vec) => v.x >= 0 && v.x < GRID && v.y >= 0 && v.y < GRID;
export const manhattan = (a: Vec, b: Vec) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const eq = (a: Vec, b: Vec) => a.x === b.x && a.y === b.y;

export const DIRS: Vec[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export function neighbors(v: Vec): Vec[] {
  return DIRS.map(d => ({ x: v.x + d.x, y: v.y + d.y })).filter(inGrid);
}

export const OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function octantOf(from: Vec, to: Vec): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  return Math.round(deg / 45) % 8;
}

export function coordLabel(v: Vec): string {
  return `${String.fromCharCode(65 + v.x)}${v.y + 1}`;
}
