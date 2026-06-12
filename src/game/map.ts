import { GRID, GameMap, Rng, Vec, idx, manhattan } from './types';

export function genMap(rng: Rng): GameMap {
  const rock = new Array<boolean>(GRID * GRID).fill(false);
  // rock ridges in the central band, away from spawn corners
  for (let i = 0; i < 3; i++) {
    let cur: Vec = { x: 3 + Math.floor(rng() * 5), y: 3 + Math.floor(rng() * 5) };
    rock[idx(cur)] = true;
    const extra = 1 + Math.floor(rng() * 2);
    for (let j = 0; j < extra; j++) {
      const d = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }][Math.floor(rng() * 4)];
      const n = { x: cur.x + d.x, y: cur.y + d.y };
      if (n.x >= 2 && n.x <= 8 && n.y >= 2 && n.y <= 8) {
        rock[idx(n)] = true;
        cur = n;
      }
    }
  }
  // thermal vents: ambient liars, spaced apart, never on rock
  const vents: Vec[] = [];
  let guard = 0;
  while (vents.length < 4 && guard++ < 300) {
    const v: Vec = { x: 1 + Math.floor(rng() * 9), y: 1 + Math.floor(rng() * 9) };
    if (rock[idx(v)]) continue;
    if (vents.some(o => manhattan(o, v) < 4)) continue;
    vents.push(v);
  }
  return { rock, vents };
}

export function spawnZones(rng: Rng): { player: Vec[]; enemy: Vec[] } {
  const corner = (right: boolean, bottom: boolean): Vec[] => {
    const cells: Vec[] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        cells.push({ x: right ? GRID - 1 - x : x, y: bottom ? GRID - 1 - y : y });
      }
    }
    return cells;
  };
  // opposite diagonal pair, randomized
  const tlbr = rng() < 0.5;
  const a = corner(false, !tlbr);
  const b = corner(true, tlbr);
  return rng() < 0.5 ? { player: a, enemy: b } : { player: b, enemy: a };
}

export function pickSpawn(zone: Vec[], map: GameMap, rng: Rng): Vec {
  const free = zone.filter(v => !map.rock[idx(v)]);
  return { ...free[Math.floor(rng() * free.length)] };
}
