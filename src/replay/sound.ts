/**
 * The replay viewer's sound: the game's own synthesized audio (src/audio: the music, the goal horn, the
 * ball and car hits, the countdown, and the engine of the car a chase camera follows), driven by the
 * events of the re-simulation. Playback follows the game's saved volumes and a Sound switch on the bar;
 * a clip's export records the same mix at the volumes the player sets for it (clip.ts adds the audio
 * track). Only while the viewer plays: a seek fast-forwards the sim without a sound.
 *
 * The browser starts audio only after a gesture, so `unlock()` goes on every press and key.
 */
import { Audio } from '../audio/Audio';
import type { AudioState } from '../audio/Audio';
import { STORAGE_PREFIX } from '../brand';
import { loadSettings } from '../settings';

const KEY = STORAGE_PREFIX + 'replay.sound';

const SILENT: AudioState = { speed: 0, forwardSpeed: 0, boosting: false, supersonic: false, grounded: true, throttle: 0 };

export class ReplaySound {
  private readonly audio: Audio;
  private on = true;
  private volume = 0.7;
  private music = 0.5;
  private exporting = false;
  private wasPlaying = false;

  /** `lite`: the device's CPU trim (no room reverb), as the game does on super low. */
  constructor(lite: boolean) {
    this.audio = new Audio({ room: !lite });
    try {
      this.on = window.localStorage.getItem(KEY) !== 'off';
    } catch {
      /* private mode */
    }
    const s = loadSettings().audio;
    this.volume = s.volume / 100;
    this.music = s.music / 100;
    this.audio.setVolume(this.on ? this.volume : 0);
    this.audio.setMusicVolume(this.music);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Whether sound can come out right now (the browser has let the context start). */
  get running(): boolean {
    return this.audio.running;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    try {
      window.localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      /* private mode */
    }
    this.apply();
    if (on) this.unlock();
  }

  /** From a gesture: create the graph and let it run. Idempotent. */
  unlock(): void {
    this.audio.resume();
  }

  private apply(): void {
    this.audio.setVolume(this.on || this.exporting ? this.volume : 0);
    this.audio.setMusicVolume(this.music);
  }

  /**
   * Once per drawn frame: the music (muffled while paused), and the engine, boost and wind of the
   * followed car (`car`; null: none, as with the broadcast camera).
   */
  frame(dt: number, car: AudioState | null, playing: boolean): void {
    if (!this.on && !this.exporting) return;
    if (!playing) {
      if (this.wasPlaying) this.audio.silence();
      this.wasPlaying = false;
      this.audio.setMusic('play', true);
      return;
    }
    this.wasPlaying = true;
    this.audio.update(dt, car ?? SILENT);
    this.audio.setMusic('play', false);
  }

  private gate(): boolean {
    return this.on || this.exporting;
  }
  countdown(): void {
    if (this.gate()) this.audio.play('countdownTick');
  }
  go(): void {
    if (this.gate()) this.audio.play('go');
  }
  goal(team: 0 | 1): void {
    if (!this.gate()) return;
    this.audio.play('goal', team);
    this.audio.musicGoal();
  }
  ballHit(strength: number): void {
    if (this.gate()) this.audio.play('ballHit', strength);
  }
  carHit(isDemo: boolean): void {
    if (this.gate()) this.audio.play('carHit', isDemo ? 1 : 0.6);
  }

  /**
   * A clip's export begins: the mix at the clip's own volumes (whatever the Sound switch says), and the
   * stream the recorder adds as its audio track (null when the browser gave no graph).
   */
  beginExport(volume: number, music: number): MediaStream | null {
    this.exporting = true;
    this.volume = Math.min(1, Math.max(0, volume));
    this.music = Math.min(1, Math.max(0, music));
    this.unlock();
    this.apply();
    return this.audio.recordingStream();
  }

  /** The export is over: back to the game's volumes. */
  endExport(): void {
    this.exporting = false;
    const s = loadSettings().audio;
    this.volume = s.volume / 100;
    this.music = s.music / 100;
    this.apply();
  }

  dispose(): void {
    this.audio.dispose();
  }
}
