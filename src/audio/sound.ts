// All audio is synthesized with WebAudio — zero external assets.
// Every entry point degrades to silence if the AudioContext is unavailable
// (headless browsers, no output device), never crashing the game.
class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private broken = false;
  private droneStarted = false;

  ensure(): AudioContext | null {
    if (this.broken) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch {
        this.broken = true;
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private env(node: AudioNode, t0: number, peak: number, attack: number, decay: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    node.connect(g);
    g.connect(this.master!);
  }

  private osc(type: OscillatorType, f0: number, f1: number, dt: number, dur: number, peak: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + dt;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    this.env(o, t0, peak, 0.012, dur);
    o.start(t0);
    o.stop(t0 + dur + 0.15);
  }

  private noise(dt: number, dur: number, peak: number, f0: number, type: BiquadFilterType, f1?: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + dt;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t0);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    src.connect(f);
    this.env(f, t0, peak, 0.02, dur);
    src.start(t0);
  }

  click() { this.osc('square', 900, 700, 0, 0.04, 0.05); }

  ping() {
    this.osc('sine', 1850, 640, 0, 0.7, 0.22);
    this.osc('sine', 2700, 900, 0, 0.35, 0.05);
  }

  echoReturn() { this.osc('sine', 1200, 500, 0.1, 0.5, 0.12); }

  murmur() { this.osc('sine', 130, 70, 0, 0.35, 0.09); }

  whoosh() { this.noise(0, 0.5, 0.12, 250, 'bandpass', 900); }

  launch() {
    this.noise(0, 0.35, 0.18, 700, 'lowpass');
    this.osc('square', 90, 55, 0, 0.3, 0.09);
  }

  explosion(big: boolean) {
    this.noise(0, big ? 1.2 : 0.8, big ? 0.5 : 0.3, 500, 'lowpass', 60);
    this.osc('sine', 60, 28, 0, big ? 1.0 : 0.7, big ? 0.5 : 0.3);
  }

  tremor() {
    this.osc('sine', 55, 45, 0, 0.16, 0.4);
    this.osc('sine', 55, 42, 0.22, 0.18, 0.32);
  }

  alarm() {
    this.osc('square', 520, 520, 0, 0.12, 0.06);
    this.osc('square', 390, 390, 0.16, 0.14, 0.06);
  }

  stinger(win: boolean) {
    const notes = win ? [220, 277, 330, 440] : [220, 208, 165, 110];
    notes.forEach((f, i) => this.osc('triangle', f, f, i * 0.18, 0.5, 0.14));
  }

  drone() {
    if (this.droneStarted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    this.droneStarted = true;
    const mk = (f: number, g: number) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn);
      gn.connect(this.master!);
      o.start();
    };
    mk(48, 0.045);
    mk(48.7, 0.04);
    mk(96, 0.012);
    // looping brown-noise bed under a low-pass: the trench breathing
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f);
    f.connect(g);
    g.connect(this.master!);
    src.start();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start();
  }
}

export const sfx = new SoundEngine();
