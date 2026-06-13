// High-res art review: drive a match a few turns and capture the canvas big,
// so I can actually judge how the abyss looks. Usage: npm run shot
import { existsSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL = process.env.DP_URL ?? 'http://localhost:5173';
const OUT = 'e2e-shots';
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const PLAY = `(() => {
  const dp = window.__dp; const s = dp.state;
  if (!s || s.result || dp.busy || dp.phase !== 'play') return false;
  const me = s.subs[dp.mySide];
  const t = s.turn % 4;
  if (t === 0) { dp.act('ping'); return true; }
  if (t === 1) { dp.act('listen'); return true; }
  const dirs = [[1,0],[0,1],[-1,0],[0,-1]];
  for (const [dx,dy] of dirs) {
    const v = { x: me.pos.x+dx, y: me.pos.y+dy };
    if (v.x>=0&&v.x<11&&v.y>=0&&v.y<11&&!s.map.rock[v.y*11+v.x]) {
      dp.act(t===2?'dash':'drift', v); return true;
    }
  }
  dp.act('listen'); return true;
})()`;

async function main() {
  const exe = BROWSERS.find(p => existsSync(p));
  if (!exe) throw new Error('no browser');
  mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: exe, headless: true,
    args: ['--mute-audio', '--force-device-scale-factor=2', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1640, height: 1000, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/art-title.png` });
  await page.click('#diveBtn');
  await sleep(800);
  for (let i = 0; i < 7; i++) { await page.evaluate(PLAY); await sleep(1700); }
  await sleep(500);
  const canvas = await page.$('#scope');
  if (canvas) await canvas.screenshot({ path: `${OUT}/art-board.png` });
  await page.screenshot({ path: `${OUT}/art-full.png` });
  await browser.close();
  console.log('shots: art-title.png, art-board.png, art-full.png');
}
main().catch(e => { console.error(e); process.exit(1); });
