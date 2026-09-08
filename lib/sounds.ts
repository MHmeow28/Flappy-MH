// All sounds are synthesized with the Web Audio API at runtime, so there
// are no audio files to source, host, or license. Everything here is
// tuned to sound soft and "cute" rather than harsh arcade beeps.

type OscType = OscillatorType;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private ambientNodes: { stop: () => void } | null = null;
  private muted = false;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 1;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  private tone(
    freq: number,
    startTime: number,
    duration: number,
    opts: {
      type?: OscType;
      peak?: number;
      glideTo?: number;
      destination?: AudioNode;
    } = {}
  ) {
    const ctx = this.ensureCtx();
    const dest = opts.destination ?? this.masterGain!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(freq, startTime);
    if (opts.glideTo) {
      osc.frequency.exponentialRampToValueAtTime(
        opts.glideTo,
        startTime + duration
      );
    }
    const peak = opts.peak ?? 0.2;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peak, startTime + duration * 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  /** Soft cat-like chirp for flapping. */
  flap() {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    this.tone(520, t, 0.09, { type: "sine", glideTo: 760, peak: 0.18 });
  }

  /** Bright little blip when passing a pipe / scoring a point. */
  score() {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    this.tone(880, t, 0.08, { type: "triangle", peak: 0.22 });
    this.tone(1320, t + 0.06, 0.1, { type: "triangle", peak: 0.18 });
  }

  /** Gentle "aw" thud + descending mew for game over. */
  gameOver() {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    this.tone(300, t, 0.35, { type: "sine", glideTo: 120, peak: 0.28 });
    this.tone(700, t + 0.05, 0.25, { type: "sine", glideTo: 260, peak: 0.12 });
  }

  /** Cheerful ascending arpeggio fanfare for a new all-time high. */
  newHighScore() {
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      this.tone(freq, t + i * 0.11, 0.22, { type: "triangle", peak: 0.24 });
    });
  }

  /** Soft menu tap. */
  tap() {
    const ctx = this.ensureCtx();
    this.tone(440, ctx.currentTime, 0.06, { type: "sine", peak: 0.15 });
  }

  /** Starts a very soft, looping ambient pad + purring pulse. Call once. */
  startAmbient() {
    if (this.ambientNodes) return;
    const ctx = this.ensureCtx();
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    gain.connect(this.masterGain!);
    this.ambientGain = gain;

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 220;
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 330;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    osc1.connect(gain);
    osc2.connect(gain);
    osc1.start();
    osc2.start();
    lfo.start();

    this.ambientNodes = {
      stop: () => {
        osc1.stop();
        osc2.stop();
        lfo.stop();
      },
    };
  }

  stopAmbient() {
    this.ambientNodes?.stop();
    this.ambientNodes = null;
  }
}

let singleton: SoundEngine | null = null;
export function getSoundEngine(): SoundEngine {
  if (!singleton) singleton = new SoundEngine();
  return singleton;
}
