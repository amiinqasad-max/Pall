/**
 * Audio.
 *
 * Every sound in TARTAN is synthesised at runtime with the Web Audio API —
 * there is not a single audio file in the bundle. That is worth about 3-5MB of
 * download on a game this size, it removes the decode spike that causes the
 * first-collision stutter on low-end Android, and it lets the music react to
 * the run (the score layer literally rises with the difficulty stage).
 *
 * The music is a generative loop: a fixed chord progression with a lookahead
 * scheduler, so it never seams and never repeats identically.
 */

import type { Settings } from '@/types';

type SfxName =
  | 'ui.tap'
  | 'ui.back'
  | 'ui.toggle'
  | 'prism'
  | 'prism.streak'
  | 'crash'
  | 'near_miss'
  | 'jump'
  | 'land'
  | 'boost'
  | 'coin'
  | 'purchase'
  | 'levelup'
  | 'achievement'
  | 'countdown'
  | 'gameover'
  | 'reward';

/** Pentatonic minor — every note in it sounds fine against every chord below. */
const SCALE = [0, 3, 5, 7, 10];
const PROGRESSION = [
  [0, 3, 7, 10], // i7
  [-4, 0, 3, 7], // VI
  [-2, 2, 5, 9], // VII
  [0, 3, 7, 12], // i
];

const BASE_FREQ = 55; // A1

function midiToFreq(semitonesFromBase: number): number {
  return BASE_FREQ * Math.pow(2, semitonesFromBase / 12);
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private settings: Settings | null = null;
  private started = false;
  private musicPlaying = false;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private step = 0;
  /** 0..1, raised as the run gets harder. Drives the lead layer's presence. */
  private intensity = 0;
  private targetIntensity = 0;
  /** Rate-limits SFX so twenty simultaneous prisms do not clip the bus. */
  private lastPlayed = new Map<string, number>();

  configure(settings: Settings): void {
    this.settings = settings;
    this.applyVolumes();
  }

  /**
   * Must be called from inside a user gesture. Browsers will not let an
   * AudioContext start otherwise, and calling it early leaves a suspended
   * context that silently swallows everything.
   */
  unlock(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;

      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 22;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.18;

      this.master = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.sfxBus = ctx.createGain();

      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.master.connect(this.compressor);
      this.compressor.connect(ctx.destination);

      this.noiseBuffer = this.buildNoise(ctx);
      this.started = true;
      this.applyVolumes();
      void ctx.resume();
    } catch {
      // Audio is a nice-to-have; a browser that refuses it should still play.
      this.started = false;
    }
  }

  private buildNoise(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 1.2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly pink-tinted noise reads warmer than pure white for impacts.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  private applyVolumes(): void {
    if (!this.started || !this.settings || !this.master || !this.musicBus || !this.sfxBus || !this.ctx) return;
    const now = this.ctx.currentTime;
    const muted = this.settings.muted;
    this.master.gain.setTargetAtTime(muted ? 0 : 1, now, 0.03);
    this.musicBus.gain.setTargetAtTime(this.settings.musicVolume * 0.5, now, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfxVolume * 0.8, now, 0.02);
  }

  // --- Music -----------------------------------------------------------------

  startMusic(): void {
    if (!this.started || !this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    this.nextNoteTime = this.ctx.currentTime + 0.08;
    this.step = 0;
    // 25ms lookahead tick scheduling ~120ms ahead: inaudible drift, and it
    // survives the main thread being busy generating track chunks.
    this.schedulerTimer = setInterval(() => this.schedule(), 25);
  }

  stopMusic(): void {
    this.musicPlaying = false;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /** 0 = menu calm, 1 = terminal-speed intensity. */
  setIntensity(value: number): void {
    this.targetIntensity = Math.max(0, Math.min(1, value));
  }

  private schedule(): void {
    if (!this.ctx || !this.musicPlaying || !this.musicBus) return;
    const secondsPerStep = 60 / 124 / 4; // 124 BPM, sixteenth notes
    while (this.nextNoteTime < this.ctx.currentTime + 0.12) {
      this.intensity += (this.targetIntensity - this.intensity) * 0.08;
      this.playStep(this.step, this.nextNoteTime);
      this.nextNoteTime += secondsPerStep;
      this.step++;
    }
  }

  private playStep(step: number, time: number): void {
    const ctx = this.ctx!;
    const bus = this.musicBus!;
    const bar = Math.floor(step / 16) % PROGRESSION.length;
    const chord = PROGRESSION[bar];
    const beat = step % 16;

    // Sub bass on the downbeat and the "and" of 3.
    if (beat === 0 || beat === 6 || beat === 10) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(midiToFreq(chord[0]), time);
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.5, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.42);
      osc.connect(gain).connect(bus);
      osc.start(time);
      osc.stop(time + 0.45);
    }

    // Pad: two detuned saws holding the chord, fading in with intensity.
    if (beat === 0) {
      for (const semitone of chord.slice(1)) {
        for (const detune of [-6, 6]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const filter = ctx.createBiquadFilter();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(midiToFreq(semitone + 24), time);
          osc.detune.setValueAtTime(detune, time);
          filter.type = 'lowpass';
          filter.frequency.setValueAtTime(500 + this.intensity * 2200, time);
          filter.Q.value = 0.8;
          const level = 0.035 + this.intensity * 0.03;
          gain.gain.setValueAtTime(0, time);
          gain.gain.linearRampToValueAtTime(level, time + 0.35);
          gain.gain.linearRampToValueAtTime(0, time + 1.9);
          osc.connect(filter).connect(gain).connect(bus);
          osc.start(time);
          osc.stop(time + 2);
        }
      }
    }

    // Hats: sixteenths, opening up as intensity climbs.
    if (this.intensity > 0.15 && beat % 2 === 1 && this.noiseBuffer) {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      src.buffer = this.noiseBuffer;
      filter.type = 'highpass';
      filter.frequency.value = 7000;
      const accent = beat % 8 === 3 ? 1.6 : 1;
      gain.gain.setValueAtTime(0.05 * this.intensity * accent, time);
      gain.gain.exponentialRampToValueAtTime(0.0005, time + 0.05);
      src.connect(filter).connect(gain).connect(bus);
      src.start(time, Math.random() * 0.4, 0.06);
    }

    // Lead arpeggio: only present in the back half of the intensity range, so
    // the menu stays calm and the late game feels genuinely more frantic.
    if (this.intensity > 0.45 && beat % 4 === 0) {
      const note = SCALE[(step / 4 + bar) % SCALE.length] + chord[0] + 36;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'square';
      osc.frequency.setValueAtTime(midiToFreq(note), time);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1800 + this.intensity * 3000, time);
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.06 * (this.intensity - 0.4), time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
      osc.connect(filter).connect(gain).connect(bus);
      osc.start(time);
      osc.stop(time + 0.22);
    }
  }

  // --- SFX -------------------------------------------------------------------

  play(name: SfxName, options: { pitch?: number; gain?: number } = {}): void {
    if (!this.started || !this.ctx || !this.sfxBus) return;
    if (this.settings?.muted) return;

    // Throttle: identical sounds inside 40ms collapse into one.
    const now = performance.now();
    const last = this.lastPlayed.get(name) ?? 0;
    if (now - last < 40) return;
    this.lastPlayed.set(name, now);

    const t = this.ctx.currentTime;
    const pitch = options.pitch ?? 1;
    const level = options.gain ?? 1;

    switch (name) {
      case 'ui.tap':
        this.blip(t, 880 * pitch, 0.05, 'sine', 0.16 * level);
        break;
      case 'ui.back':
        this.sweep(t, 620, 340, 0.1, 'sine', 0.14 * level);
        break;
      case 'ui.toggle':
        this.blip(t, 1200 * pitch, 0.035, 'triangle', 0.12 * level);
        break;
      case 'prism':
        // Rising blip; `pitch` carries the collection streak so a chain of
        // prisms plays as an ascending run.
        this.blip(t, 1046 * pitch, 0.07, 'triangle', 0.2 * level);
        this.blip(t + 0.045, 1568 * pitch, 0.06, 'sine', 0.14 * level);
        break;
      case 'prism.streak':
        this.blip(t, 1568 * pitch, 0.09, 'triangle', 0.22 * level);
        this.blip(t + 0.05, 2093 * pitch, 0.08, 'sine', 0.16 * level);
        break;
      case 'coin':
        this.blip(t, 1318, 0.06, 'square', 0.14 * level);
        this.blip(t + 0.05, 1760, 0.09, 'square', 0.12 * level);
        break;
      case 'crash':
        this.impact(t, 0.55 * level);
        this.sweep(t, 220, 55, 0.5, 'sawtooth', 0.3 * level);
        break;
      case 'near_miss':
        this.sweep(t, 1800, 900, 0.14, 'sine', 0.1 * level);
        break;
      case 'jump':
        this.sweep(t, 420, 760, 0.14, 'triangle', 0.16 * level);
        break;
      case 'land':
        this.impact(t, 0.18 * level, 0.12);
        break;
      case 'boost':
        this.sweep(t, 300, 1400, 0.35, 'sawtooth', 0.14 * level);
        break;
      case 'purchase':
        this.chord(t, [523, 659, 784], 0.3, 0.13 * level);
        break;
      case 'levelup':
        this.chord(t, [523, 659, 784, 1046], 0.5, 0.15 * level);
        this.blip(t + 0.18, 1318, 0.3, 'triangle', 0.12 * level);
        break;
      case 'achievement':
        this.chord(t, [440, 554, 659], 0.35, 0.12 * level);
        this.blip(t + 0.2, 880, 0.25, 'sine', 0.1 * level);
        break;
      case 'reward':
        this.chord(t, [659, 784, 988, 1318], 0.6, 0.14 * level);
        break;
      case 'countdown':
        this.blip(t, 660 * pitch, 0.12, 'square', 0.18 * level);
        break;
      case 'gameover':
        this.sweep(t, 440, 110, 0.9, 'triangle', 0.18 * level);
        break;
    }
  }

  private blip(time: number, freq: number, duration: number, type: OscillatorType, level: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0005, time + duration);
    osc.connect(gain).connect(this.sfxBus!);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  private sweep(
    time: number,
    from: number,
    to: number,
    duration: number,
    type: OscillatorType,
    level: number,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), time + duration);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0005, time + duration);
    osc.connect(gain).connect(this.sfxBus!);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  private impact(time: number, level: number, duration = 0.35): void {
    if (!this.noiseBuffer) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    src.buffer = this.noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, time);
    filter.frequency.exponentialRampToValueAtTime(180, time + duration);
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.0005, time + duration);
    src.connect(filter).connect(gain).connect(this.sfxBus!);
    src.start(time, Math.random() * 0.3, duration + 0.05);
  }

  private chord(time: number, freqs: number[], duration: number, level: number): void {
    freqs.forEach((f, i) => {
      // Small stagger turns a block chord into an arpeggiated flourish.
      this.blip(time + i * 0.055, f, duration, 'triangle', level);
    });
  }

  get isStarted(): boolean {
    return this.started;
  }
}

export const audio = new AudioEngine();
export type { SfxName };
