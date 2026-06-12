// P2P online via trystero (nostr signaling): WebRTC with public relays, no server
// of our own. Lockstep determinism: host sends a seed, both clients run identical
// rules with the same rng; each turn both exchange actions and resolve locally.
import { joinRoom, type JsonValue } from 'trystero';
import { Action } from '../game/types';

const APP_ID = 'frikex-dead-ping-v1';
const CODE_CHARS = 'ABCDEFGHJKMNPRSTUVWXYZ';

export function genCode(): string {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

export interface NetSession {
  code: string;
  isHost: boolean;
  sendInit(seed: number): void;
  sendAction(turn: number, action: Action): void;
  onInit(cb: (seed: number) => void): void;
  onAction(cb: (turn: number, action: Action) => void): void;
  onJoin(cb: () => void): void;
  onLeave(cb: () => void): void;
  leave(): void;
}

export function createSession(code: string, isHost: boolean): NetSession {
  const room = joinRoom({ appId: APP_ID }, code);
  const init = room.makeAction<number>('init');
  const act = room.makeAction('act');
  return {
    code,
    isHost,
    sendInit: seed => void init.send(seed),
    sendAction: (turn, action) =>
      void act.send({ t: turn, a: action } as unknown as JsonValue),
    onInit: cb => {
      init.onMessage = data => cb(data);
    },
    onAction: cb => {
      act.onMessage = data => {
        const p = data as unknown as { t: number; a: Action };
        if (p && typeof p.t === 'number' && p.a) cb(p.t, p.a);
      };
    },
    onJoin: cb => {
      room.onPeerJoin = () => cb();
    },
    onLeave: cb => {
      room.onPeerLeave = () => cb();
    },
    leave: () => void room.leave(),
  };
}
