// End-to-end test driving a real browser over CDP (puppeteer-core).
// Requires the dev server running (npm run dev). Usage: npm run e2e
//   Test 1: full match vs the AI using the window.__dp hooks.
//   Test 2: online duel between two tabs, asserting lockstep determinism.
import { existsSync, mkdirSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';

const URL = process.env.DP_URL ?? 'http://localhost:5173';
const SHOTS = 'e2e-shots';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(page: Page, fn: string, timeoutMs: number, label: string): Promise<unknown> {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout esperando: ${label}`);
    await sleep(200);
  }
}

async function newPage(browser: Browser, errors: string[]): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 940 });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(URL, { waitUntil: 'networkidle2' });
  return page;
}

// one turn of scripted play: torpedo a fresh last-known fix, otherwise rotate listen/ping/drift
const PLAY_TURN = `(() => {
  const dp = window.__dp;
  const s = dp.state;
  if (!s) return 'no-state';
  if (s.result) return 'over';
  if (dp.busy) return false;
  const me = s.subs[dp.mySide];
  const lk = dp.lastKnown;
  if (lk && me.cooldown === 0 && s.turn - lk.turn <= 2) {
    const d = Math.abs(lk.pos.x - me.pos.x) + Math.abs(lk.pos.y - me.pos.y);
    if (d >= 2 && d <= 4) { dp.act('torpedo', lk.pos); return 'fired'; }
  }
  const t = s.turn % 3;
  if (t === 0) { dp.act('listen'); return 'listen'; }
  if (t === 1) { dp.act('ping'); return 'ping'; }
  const dirs = [[0,-1],[1,0],[0,1],[-1,0]];
  for (const [dx,dy] of dirs) {
    const v = { x: me.pos.x + dx, y: me.pos.y + dy };
    if (v.x>=0 && v.x<11 && v.y>=0 && v.y<11 && !s.map.rock[v.y*11+v.x]) { dp.act('drift', v); return 'drift'; }
  }
  dp.act('listen');
  return 'listen';
})()`;

async function testAiMatch(browser: Browser, errors: string[]) {
  console.log('--- TEST 1: partida completa vs IA ---');
  const page = await newPage(browser, errors);
  await page.screenshot({ path: `${SHOTS}/01-titulo.png` });
  await page.click('#diveBtn');
  await waitFor(page, 'window.__dp && window.__dp.state !== null', 5000, 'inicio de partida');

  let shotMid = false;
  for (let i = 0; i < 120; i++) {
    const r = await page.evaluate(PLAY_TURN);
    if (r === 'over') break;
    if (r === 'fired') console.log('  torpedo disparado al LKP');
    await sleep(r === false ? 400 : 1800);
    const turn = await page.evaluate('window.__dp.state ? window.__dp.state.turn : -1');
    if (!shotMid && (turn as number) >= 6) {
      await page.screenshot({ path: `${SHOTS}/02-partida.png` });
      shotMid = true;
    }
  }
  const result = await page.evaluate('window.__dp.state && window.__dp.state.result');
  if (!result) throw new Error('la partida vs IA no terminó');
  await sleep(2800); // end overlay
  await page.screenshot({ path: `${SHOTS}/03-final.png` });
  console.log('  resultado:', JSON.stringify(result));
  const lb = await page.evaluate(`localStorage.getItem('deadping.logbook.v1')`);
  if (!lb) throw new Error('la bitácora no se guardó en localStorage');
  console.log('  bitácora:', lb);
  await page.close();
  console.log('  OK');
}

async function testOnlineDuel(browser: Browser, errors: string[]) {
  console.log('--- TEST 2: duelo online entre dos pestañas ---');
  const host = await newPage(browser, errors);
  console.log('  página host cargada');
  const guest = await newPage(browser, errors);
  console.log('  página guest cargada');

  await host.evaluate(`document.getElementById('hostBtn').click()`);
  const code = (await waitFor(
    host,
    `(document.getElementById('roomCode') || {}).textContent || false`,
    10000,
    'código de sala',
  )) as string;
  console.log('  sala creada:', code);

  await guest.evaluate(`
    const i = document.getElementById('codeInput');
    i.value = '${code}';
    document.getElementById('joinBtn').click();
  `);
  console.log('  guest uniéndose…');

  await waitFor(host, 'window.__dp.state !== null', 90000, 'host: inicio del duelo');
  await waitFor(guest, 'window.__dp.state !== null', 90000, 'guest: inicio del duelo');
  console.log('  ambos clientes iniciaron el duelo');

  for (let t = 1; t <= 3; t++) {
    await waitFor(host, '!window.__dp.busy', 20000, `host listo turno ${t}`);
    await waitFor(guest, '!window.__dp.busy', 20000, `guest listo turno ${t}`);
    await host.evaluate(`window.__dp.act('listen')`);
    await guest.evaluate(`window.__dp.act('listen')`);
    await waitFor(host, `window.__dp.state.turn === ${t}`, 20000, `host resolvió turno ${t}`);
    await waitFor(guest, `window.__dp.state.turn === ${t}`, 20000, `guest resolvió turno ${t}`);
    console.log(`  turno ${t} resuelto en ambos lados`);
  }

  const SNAP = `JSON.stringify({ t: window.__dp.state.turn, subs: window.__dp.state.subs, decoys: window.__dp.state.decoys })`;
  const a = await host.evaluate(SNAP);
  const b = await guest.evaluate(SNAP);
  if (a !== b) {
    console.log('  host :', a);
    console.log('  guest:', b);
    throw new Error('DESYNC: los estados no coinciden');
  }
  console.log('  determinismo verificado: estados idénticos en ambos clientes');
  await host.screenshot({ path: `${SHOTS}/04-online.png` });
  await host.close();
  await guest.close();
  console.log('  OK');
}

async function main() {
  const exe = BROWSERS.find(p => existsSync(p));
  if (!exe) throw new Error('no encontré Brave/Chrome/Edge instalado');
  console.log('navegador:', exe);
  mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = [];
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    protocolTimeout: 60000,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
  });
  try {
    await testAiMatch(browser, errors);
    await testOnlineDuel(browser, errors);
  } finally {
    await browser.close();
  }
  const real = errors.filter(e => !e.includes('favicon'));
  if (real.length) {
    console.log('\nERRORES DE CONSOLA:');
    for (const e of real) console.log(' -', e);
    process.exit(1);
  }
  console.log('\nTODO OK — sin errores de consola.');
}

main().catch(e => {
  console.error('E2E FALLÓ:', e.message ?? e);
  process.exit(1);
});
