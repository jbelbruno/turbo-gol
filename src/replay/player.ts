/**
 * The replay player: re-simulates a community-node replay (nodes/shared/replay.ts) and draws it
 * with the game's own views and HUD.
 *
 * A replay holds only the controls the host applied to the human slots, so the match is played
 * again exactly as the verifiers do it (nodes/shared/verify.ts): a fresh arena with the roster and
 * the kickoff seed, the same RoomHost (rules, bots, kickoffs) fed the recorded inputs and takeovers
 * tick by tick. Before the first frame the whole match is run once (`scan`): it finds the goals and
 * their scorers for the timeline and compares every state-hash checkpoint, so the viewer knows
 * up front whether this build reproduces the recording (a match played on another wasm, protocol
 * or JavaScript drifts away; from the first mismatch on, what is shown is not what was played).
 *
 * Seeking forward fast-forwards the sim; seeking back restarts it from tick 1 (a 3-minute match
 * runs in well under a second on a desktop).
 */
import * as THREE from 'three/webgpu';
import { RoomHost } from '../../server/src/roomHost';
import type { Replay } from '../../nodes/shared/replay';
import { STORAGE_PREFIX } from '../brand';
import { t } from '../i18n';
import type { MatchEvent } from '../net/protocol';
import { ArenaView } from '../render/Arena';
import { BallView } from '../render/Ball';
import { ChaseCamera, clampToArena } from '../render/Camera';
import type { CameraCarState } from '../render/Camera';
import { CarView } from '../render/Car';
import { Effects } from '../render/Effects';
import { Hud } from '../render/Hud';
import { NameTags } from '../render/nameTags';
import type { Renderer } from '../render/Renderer';
import type { ArenaMesh } from '../sim/arenaMesh';
import { RocketSim } from '../sim/RocketSimBridge';
import {
  B_POS,
  BALL_OFFSET,
  C_IS_ON_GROUND,
  C_IS_BOOSTING,
  C_IS_SUPERSONIC,
  C_ROT,
  C_VEL,
  CarPreset,
  NUM_BOOST_PADS,
  PACKED_INPUT_BYTES,
  PAD_STRIDE,
  PADS_OFFSET,
  P_COOLDOWN,
  P_IS_ACTIVE,
  STATE_BUFFER_FLOATS,
  TICK_DT,
  TICK_RATE,
} from '../sim/types';
import wasmUrl from '../sim/wasm/rocketsim.wasm?url';
import { drawsFrame } from '../render/quality';
import { goalScorer } from '../ui/screens/match/finalModel';
import { escLocked, fullscreenEnv, togglePageFullscreen } from '../ui/fullscreen';
import { ReplaySound } from './sound';
import { ClipTimeline } from './timeline';
import { GOAL_CAPTION_SECONDS, ClipRecorder, canRecordClips, clampClipRange, clipFileName, clipSize, clipWindow, defaultClipRange, drawOverlay, estimateBytes, shareUrl, timeText } from './clip';
import type { ClipFormat, ClipQuality, ClipResult } from './clip';
import type { AudioState } from '../audio/Audio';
import { escArmStep, escMenuAction } from '../game/pauseKeys';
import { replayName } from './names';
import { clockText, el } from './list';

/** Longest frame the loop catches up on (s). */
const MAX_FRAME_DT = 0.1;
/** Wall-clock budget per frame for a fast-forward or the scan (ms). */
const BUSY_BUDGET_MS = 25;
/** The chase cameras' distance range (uu; settings.ts allows 100-400 in the game, a replay lets it go further). */
const CHASE_MIN = 100;
const CHASE_MAX = 500;
/** The orbital camera's distance and pitch limits (it is also kept inside the arena: Camera.ts clampToArena). */
const ORBIT_MIN = 150;
const ORBIT_MAX = 4200;
const PITCH_MIN = 0.05;
const PITCH_MAX = 1.45;
/** The lead a jump to a goal keeps before it (s), so the play that made it shows. */
const GOAL_LEAD_SECONDS = 4;
const CAM_KEY = STORAGE_PREFIX + 'replay.cam';

interface CamPrefs {
  chaseDist: number;
  orbitDist: number;
  ballCam: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** What the viewer remembers about the cameras (best effort: storage can be off). */
function loadCamPrefs(): CamPrefs {
  const d: CamPrefs = { chaseDist: 270, orbitDist: 1400, ballCam: true };
  try {
    const p = JSON.parse(window.localStorage.getItem(CAM_KEY) ?? 'null') as Partial<CamPrefs> | null;
    if (p && typeof p === 'object') {
      if (typeof p.chaseDist === 'number' && Number.isFinite(p.chaseDist)) d.chaseDist = clamp(p.chaseDist, CHASE_MIN, CHASE_MAX);
      if (typeof p.orbitDist === 'number' && Number.isFinite(p.orbitDist)) d.orbitDist = clamp(p.orbitDist, ORBIT_MIN, ORBIT_MAX);
      if (typeof p.ballCam === 'boolean') d.ballCam = p.ballCam;
    }
  } catch {
    /* private mode */
  }
  return d;
}

const CLIP_KEY = STORAGE_PREFIX + 'replay.clip';
interface ClipPrefs {
  format: ClipFormat;
  quality: ClipQuality;
  names: boolean;
  /** Sound in the export, and its volume and music level (0-100). */
  sound: boolean;
  volume: number;
  music: number;
}

/** What the Clip sheet remembers (best effort: storage can be off). */
function loadClipPrefs(): ClipPrefs {
  const d: ClipPrefs = { format: 'vertical', quality: 'high', names: true, sound: true, volume: 80, music: 50 };
  try {
    const p = JSON.parse(window.localStorage.getItem(CLIP_KEY) ?? 'null') as Partial<ClipPrefs> | null;
    if (p && typeof p === 'object') {
      if (p.format === 'vertical' || p.format === 'square' || p.format === 'wide') d.format = p.format;
      if (p.quality === 'standard' || p.quality === 'high' || p.quality === 'max') d.quality = p.quality;
      if (typeof p.names === 'boolean') d.names = p.names;
      if (typeof p.sound === 'boolean') d.sound = p.sound;
      if (typeof p.volume === 'number' && Number.isFinite(p.volume)) d.volume = clamp(p.volume, 0, 100);
      if (typeof p.music === 'number' && Number.isFinite(p.music)) d.music = clamp(p.music, 0, 100);
    }
  } catch {
    /* private mode */
  }
  return d;
}

function saveClipPrefs(p: ClipPrefs): void {
  try {
    window.localStorage.setItem(CLIP_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

function saveCamPrefs(p: CamPrefs): void {
  try {
    window.localStorage.setItem(CAM_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

/** How long the GO caption stays (Game.ts GO_CAPTION_SECONDS). */
const GO_CAPTION_TICKS = Math.round(0.8 * TICK_RATE);
const TEAM_NAME = [() => t('game.teamBlueUpper'), () => t('game.teamRedUpper')] as const;

/** One run of the match: a fresh sim and RoomHost, fed from tick 1. */
interface Run {
  sim: RocketSim;
  host: RoomHost;
  /** Current applied controls of every slot (the replay stores changes only). */
  cur: Int8Array;
  ii: number;
  ti: number;
  hi: number;
}

export interface Goal {
  tick: number;
  team: 0 | 1;
  /** The scorer's slot, -1 when none of the team touched the ball in that play. */
  slot: number;
}

export interface ScanResult {
  goals: Goal[];
  /** The first checkpoint that did not match (tick), -1 when every one did. */
  divergedAt: number;
  /** Checkpoints compared. */
  checked: number;
}

/**
 * rocketsim.wasm compiled once for the page: the scan and every back-seek instantiate it again (a
 * fresh instance: its own memory and arena) without fetching or compiling it again. Null when
 * streaming compilation is unavailable: RocketSim.load() then finds the file itself.
 */
let wasmModule: Promise<WebAssembly.Module | null> | null = null;
function compiledWasm(): Promise<WebAssembly.Module | null> {
  if (!wasmModule) {
    wasmModule = (typeof WebAssembly.compileStreaming === 'function' ? WebAssembly.compileStreaming(fetch(wasmUrl)) : Promise.reject(new Error('no compileStreaming'))).catch(() => null);
  }
  return wasmModule;
}

async function newRun(r: Replay, mesh: ArenaMesh): Promise<Run> {
  const h = r.header;
  const mod = await compiledWasm();
  const sim = mod ? await RocketSim.load({ wasmModule: mod }) : await RocketSim.load();
  sim.initArena(mesh.physics);
  sim.createArena(TICK_RATE);
  for (const e of h.roster) sim.addCar(e.team, CarPreset.Standard);
  sim.resetKickoff(h.kickoffSeed);
  sim.sync();
  const host = new RoomHost(sim, h.roster, {
    tickRate: TICK_RATE,
    snapshotEvery: 4,
    matchLengthSeconds: h.matchLengthSeconds,
    kickoffSeed: h.kickoffSeed,
    botDifficulty: h.botDifficulty,
    kickoffCountdownSeconds: h.kickoffCountdownSeconds,
    goalPauseSeconds: h.goalPauseSeconds,
  });
  host.start();
  return { sim, host, cur: new Int8Array(h.roster.length * PACKED_INPUT_BYTES), ii: 0, ti: 0, hi: 0 };
}

/** One tick of the re-simulation (verify.ts's loop body). Returns false when a checkpoint did not match. */
function step(rn: Run, r: Replay): boolean {
  const host = rn.host;
  const T = host.currentTick + 1;
  while (rn.ti < r.takeovers.length && r.takeovers[rn.ti].tick <= T) {
    host.convertToBot(r.takeovers[rn.ti].slot);
    rn.ti++;
  }
  while (rn.ii < r.inputCount && r.inputTicks[rn.ii] === T) {
    const s = r.inputSlots[rn.ii];
    for (let k = 0; k < PACKED_INPUT_BYTES; k++) rn.cur[s * PACKED_INPUT_BYTES + k] = r.inputData[rn.ii * PACKED_INPUT_BYTES + k];
    rn.ii++;
  }
  const slots = r.header.roster.length;
  for (let s = 0; s < slots; s++) if (host.isHumanSlot(s)) host.addInputs(s, T, 1, rn.cur, s * PACKED_INPUT_BYTES);
  host.tick();
  if (rn.hi < r.hashCount && r.hashTicks[rn.hi] === T) {
    const ok = rn.sim.stateHash() >>> 0 === r.hashValues[rn.hi];
    rn.hi++;
    return ok;
  }
  return true;
}

/** The last tick to play: END, or the last record of a replay without one. */
export function endTickOf(r: Replay): number {
  if (r.end) return r.end.tick;
  let e = r.inputCount > 0 ? r.inputTicks[r.inputCount - 1] : 0;
  if (r.hashCount > 0) e = Math.max(e, r.hashTicks[r.hashCount - 1]);
  return e;
}

/**
 * Let the page breathe between two chunks of the scan. A message, not setTimeout: a tab in the
 * background throttles timers to one a second (the scan would take minutes), not messages.
 */
function yieldTask(): Promise<void> {
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      res();
    };
    ch.port2.postMessage(0);
  });
}

/** Run the whole match once: the goals (and scorers) and the checkpoints. Yields every BUSY_BUDGET_MS. */
export async function scan(r: Replay, mesh: ArenaMesh, onProgress: (p: number) => void): Promise<ScanResult> {
  const rn = await newRun(r, mesh);
  const end = endTickOf(r);
  const events: MatchEvent[] = [];
  const goals: Goal[] = [];
  let divergedAt = -1;
  let playFrom = 0;
  while (rn.host.currentTick < end) {
    const t0 = performance.now();
    while (rn.host.currentTick < end && performance.now() - t0 < BUSY_BUDGET_MS) {
      if (!step(rn, r) && divergedAt < 0) divergedAt = rn.host.currentTick;
      rn.host.takeEvents(events);
      for (const e of events) {
        if (e.type === 'go') playFrom = e.tick;
        else if (e.type === 'goal') goals.push({ tick: e.tick, team: e.team, slot: goalScorer(rn.sim.buf, e.team, playFrom) });
      }
    }
    onProgress(end > 0 ? rn.host.currentTick / end : 1);
    await yieldTask();
  }
  return { goals, divergedAt, checked: rn.hi };
}

export interface PlayerOptions {
  replay: Replay;
  scan: ScanResult;
  renderer: Renderer;
  mesh: ArenaMesh;
  hudRoot: HTMLElement;
  tagsRoot: HTMLElement;
  bar: HTMLElement;
  /** The match's id when it came from the server (a goal's link needs it), null for a local file. */
  matchId: string | null;
  /** A link's ?t=: the goal tick to open at (null: from the start). */
  startTick: number | null;
}

/** Play `replay` on the page: the views, the HUD, the name tags and the control bar. Returns its stop (the loop ends). */
export async function startPlayer(o: PlayerOptions): Promise<() => void> {
  const r = o.replay;
  const renderer = o.renderer;
  const scene = renderer.scene;
  const q = renderer.quality;
  const roster = r.header.roster;
  /** Each slot's name as shown: a guest's server name ('Invitado 4821') and a hidden one ('Jugador 3') in this page's language. */
  const shownName = roster.map((e) => (e.kind === 'player' ? replayName(e.name) : e.name));
  const endTick = endTickOf(r);

  let run = await newRun(r, o.mesh);
  const prev = new Float32Array(STATE_BUFFER_FLOATS);
  const cur = new Float32Array(STATE_BUFFER_FLOATS);
  const takeState = (): void => {
    prev.set(cur);
    cur.set(run.sim.buf.subarray(0, STATE_BUFFER_FLOATS));
  };
  cur.set(run.sim.buf.subarray(0, STATE_BUFFER_FLOATS));
  prev.set(cur);

  // Views (Game.buildViews).
  const arena = new ArenaView(scene, o.mesh, q, renderer.theme);
  const ball = new BallView(scene, q);
  const config = run.sim.getCarConfig(CarPreset.Standard);
  const effects = new Effects(scene, q, renderer.camera);
  const cars: CarView[] = [];
  const offsets: number[] = [];
  const slots: number[] = [];
  for (const e of roster) {
    const team = run.sim.teamOf(e.slot);
    cars.push(new CarView(scene, config, team, q));
    effects.registerCar(e.slot, team);
    slots.push(e.slot);
    offsets.push(run.sim.carOffset(e.slot));
  }
  // The game's name tags (src/render/nameTags.ts) as a spectator sees them: no team of its own, so
  // every car shows its boost; a seat the host's bot took over shows as a bot from then on (placeTags).
  const tags = new NameTags(o.tagsRoot);
  const tagRows = roster.map((e, i) => ({ name: shownName[i], team: e.team, you: false, bot: e.kind === 'bot' }));
  tags.setVisible(true);

  const hud = new Hud(o.hudRoot);
  // The game's own audio (sound.ts): the browser starts it on a gesture, so every press and key tries.
  const sound = new ReplaySound(renderer.spec.cpuLite);
  const unlockSound = (): void => sound.unlock();
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlockSound, { passive: true });
  // Super low drops the blur, shadows and decorative animation of the page (src/style.css), as the game does.
  document.documentElement.classList.toggle('tg-superlow', renderer.spec.cpuLite);
  const events: MatchEvent[] = [];
  const goalAt = new Map(o.scan.goals.map((g) => [g.tick, g]));
  /** The ball's place at a goal, for the explosion (sim coordinates). */
  const goalPos: [number, number, number] = [0, 0, 0];

  // The game's ball-hit sparks and sound and its car-hit sound, from the sim's events: only on the ticks the
  // viewer plays (a seek fast-forwards the sim without them), a touch of a car at most every 6 ticks (Game.ts).
  let liveStep = false;
  const hitPos: [number, number, number] = [0, 0, 0];
  const lastHit = new Int32Array(roster.length).fill(-1000);
  const hookSim = (rn: Run): void => {
    rn.sim.events.onBallHit = (carId, relSpeed) => {
      if (!liveStep || relSpeed < 250) return;
      const slot = rn.sim.slotOf(carId);
      if (slot < 0) return;
      const tick = rn.sim.tickCount;
      if (tick - lastHit[slot] < 6) return;
      lastHit[slot] = tick;
      const b = rn.sim.buf;
      hitPos[0] = b[BALL_OFFSET + B_POS];
      hitPos[1] = b[BALL_OFFSET + B_POS + 1];
      hitPos[2] = b[BALL_OFFSET + B_POS + 2];
      effects.onBallHit(hitPos, relSpeed);
      sound.ballHit(relSpeed / 3000);
    };
    rn.sim.events.onBump = (_bumper, _victim, isDemo) => {
      if (liveStep) sound.carHit(isDemo);
    };
  };
  hookSim(run);
  /** Once per drawn frame: the music and, with a chase camera, the engine, boost and wind of the car it follows. */
  const soundStep = (dt: number): void => {
    let car: AudioState | null = null;
    if (camIndex >= CAM_CAR0 && sound.running) {
      const po = offsets[camIndex - CAM_CAR0];
      const v = po + C_VEL;
      const f = po + C_ROT;
      const speed = Math.hypot(cur[v], cur[v + 1], cur[v + 2]);
      const boosting = cur[po + C_IS_BOOSTING] > 0.5;
      car = {
        speed,
        forwardSpeed: cur[v] * cur[f] + cur[v + 1] * cur[f + 1] + cur[v + 2] * cur[f + 2],
        boosting,
        supersonic: cur[po + C_IS_SUPERSONIC] > 0.5,
        grounded: cur[po + C_IS_ON_GROUND] > 0.5,
        throttle: boosting ? 1 : Math.min(1, speed / 900),
      };
    }
    sound.frame(dt, car, playing && seekTarget < 0 && !restarting);
  };

  // ---- the control bar ------------------------------------------------------------------------
  const playBtn = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.pause')) as HTMLButtonElement;
  const speedSel = el('select.rp-btn', { 'aria-label': t('replay.speed') }) as HTMLSelectElement;
  for (const s of [0.25, 0.5, 1, 2, 4, 8]) speedSel.append(el('option', { value: String(s) }, `${s}×`));
  speedSel.value = '1';
  const camSel = el('select.rp-btn', { 'aria-label': t('replay.camera') }) as HTMLSelectElement;
  camSel.append(el('option', { value: '0' }, `0 · ${t('replay.broadcast')}`));
  camSel.append(el('option', { value: '1' }, `1 · ${t('replay.orbital')}`));
  roster.forEach((_e, i) => camSel.append(el('option', { value: String(i + 2) }, `${i + 2} · ${shownName[i]}`)));
  const seek = el('input', { type: 'range', min: '0', max: String(endTick), step: '1', value: '0', 'aria-label': t('replay.title') }) as HTMLInputElement;
  const marks = el('div.rp-marks');
  for (const g of o.scan.goals) {
    const m = el(`div.rp-mark.${g.team === 0 ? 'rp-blue' : 'rp-red'}`);
    m.style.left = `${(100 * g.tick) / Math.max(1, endTick)}%`;
    marks.append(m);
  }
  const time = el('span.rp-time', null, '');
  const list = el('a.rp-btn', { href: './replay.html' }, t('replay.list'));
  const goals = [...o.scan.goals].sort((a, b) => a.tick - b.tick);
  const prevGoalBtn = el('button.rp-btn', { type: 'button' }, t('replay.prevGoal')) as HTMLButtonElement;
  const nextGoalBtn = el('button.rp-btn', { type: 'button' }, t('replay.nextGoal')) as HTMLButtonElement;
  const clipBtn = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.clip')) as HTMLButtonElement;
  const soundBtn = el('button.rp-btn', { type: 'button', 'aria-pressed': String(sound.enabled) }, t(sound.enabled ? 'replay.soundOn' : 'replay.soundOff')) as HTMLButtonElement;
  soundBtn.addEventListener('click', () => {
    sound.setEnabled(!sound.enabled);
    soundBtn.setAttribute('aria-pressed', String(sound.enabled));
    soundBtn.textContent = t(sound.enabled ? 'replay.soundOn' : 'replay.soundOff');
  });
  // Short screens (a phone on its side) keep one thin line: the second one opens with this.
  const moreBtn = el('button.rp-btn.rp-more-btn', { type: 'button', 'aria-expanded': 'false', 'aria-label': t('replay.moreControls') }, '···') as HTMLButtonElement;
  moreBtn.addEventListener('click', () => moreBtn.setAttribute('aria-expanded', String(o.bar.classList.toggle('rp-more'))));
  // The chase cameras' own controls: ball cam or car cam, and how far behind (shown with a car's camera).
  const ballCamBtn = el('button.rp-btn', { type: 'button' }, '') as HTMLButtonElement;
  const distSlider = el('input', { type: 'range', min: String(CHASE_MIN), max: String(CHASE_MAX), step: '10', 'aria-label': t('replay.distance') }) as HTMLInputElement;
  const chaseCtl = el('span.rp-ctl.rp-hidden', null, ballCamBtn, el('span.rp-ctl-label', null, t('replay.distance')), distSlider);
  const hint = el('span.rp-keys.rp-grow', null, '');
  // Full screen by hand (its button, the F key), never by itself: the page loads with no press.
  // Not where the page cannot go full screen (an iPhone).
  const fullscreenBtn = el('button.rp-btn', { type: 'button', 'aria-pressed': 'false' }, t('replay.fullscreen')) as HTMLButtonElement;
  document.addEventListener('fullscreenchange', () => fullscreenBtn.setAttribute('aria-pressed', String(document.fullscreenElement != null)));
  o.bar.replaceChildren(
    el('div.rp-line', null, playBtn, el('div.rp-track', null, marks, seek), time, clipBtn, moreBtn),
    el('div.rp-line', null, speedSel, camSel, soundBtn, chaseCtl, goals.length > 0 ? prevGoalBtn : null, goals.length > 0 ? nextGoalBtn : null, hint, fullscreenEnv().elementFullscreen ? fullscreenBtn : null, list),
  );
  o.bar.classList.remove('rp-hidden');

  // ---- state ----------------------------------------------------------------------------------
  let acc = 0;
  let last = -1;
  let playing = true;
  let speed = 1;
  let seekTarget = -1;
  let restarting = false;
  /** The timeline thumb is held: playback does not move it meanwhile. */
  let dragging = false;
  /** The tick the GO caption goes at (-1: none showing). */
  let goHideTick = -1;
  let lastDrawn = -1;
  /** 0 broadcast, 1 orbital (free, with the mouse), 2 + i a car's chase camera. */
  let camIndex = 0;
  const CAM_ORBIT = 1;
  const CAM_CAR0 = 2;
  let snapChase = true;
  const chase = new ChaseCamera();
  const prefs = loadCamPrefs();
  chase.settings.distance = prefs.chaseDist;
  chase.ballCam = prefs.ballCam;
  /** The orbital camera: spherical round `target` (which follows the ball until it is moved by hand). */
  const orbit = { yaw: -0.7, pitch: 0.5, dist: prefs.orbitDist, follow: true, target: new THREE.Vector3() };
  const camState: CameraCarState = { grounded: true, speed: 0, supersonic: false };
  const lookAt = new THREE.Vector3();

  const setPlaying = (p: boolean): void => {
    playing = p;
    playBtn.textContent = p ? t('replay.pause') : t('replay.play');
  };
  /** The bar's camera controls and the hint line follow the camera. */
  const updateCamUi = (): void => {
    const car = camIndex >= CAM_CAR0;
    chaseCtl.classList.toggle('rp-hidden', !car);
    distSlider.value = String(Math.round(chase.settings.distance));
    ballCamBtn.textContent = chase.ballCam ? t('replay.ballCam') : t('replay.carCam');
    hint.textContent = camIndex === CAM_ORBIT ? t('replay.orbitHint') : car ? t('replay.chaseHint') : t('replay.keys', { max: roster.length + 1 });
    renderer.gpu.domElement.style.cursor = camIndex === CAM_ORBIT ? 'grab' : '';
  };
  const setCam = (n: number): void => {
    if (n < 0 || n > cars.length + 1) return;
    camIndex = n;
    camSel.value = String(n);
    snapChase = true;
    updateCamUi();
    onCamChange?.();
  };
  /** Zoom the current camera by `f` (< 1 closer): the orbital's distance or a chase camera's. */
  const zoomBy = (f: number): void => {
    if (camIndex === CAM_ORBIT) orbit.dist = clamp(orbit.dist * f, ORBIT_MIN, ORBIT_MAX);
    else if (camIndex >= CAM_CAR0) chase.settings.distance = clamp(chase.settings.distance * f, CHASE_MIN, CHASE_MAX);
    else return;
    prefs.orbitDist = orbit.dist;
    prefs.chaseDist = chase.settings.distance;
    saveCamPrefs(prefs);
    distSlider.value = String(Math.round(chase.settings.distance));
  };
  /** Where the viewer is, or is going: a seek in progress counts as done. */
  const pos = (): number => (seekTarget >= 0 ? seekTarget : run.host.currentTick);
  const seekTo = (tick: number): void => {
    const target = Math.max(0, Math.min(endTick, Math.round(tick)));
    seekTarget = target;
    // While a restart loads, the new run starts at tick 0 and fast-forwards to the latest target.
    if (target < run.host.currentTick && !restarting) {
      restarting = true;
      newRun(r, o.mesh).then(
        (rn) => {
          run = rn;
          hookSim(rn);
          cur.set(rn.sim.buf.subarray(0, STATE_BUFFER_FLOATS));
          prev.set(cur);
          restarting = false;
        },
        (e: unknown) => {
          console.error('replay restart failed', e);
          restarting = false;
          seekTarget = -1;
        },
      );
    }
  };
  /** Jump to the goal before / after the current moment (a lead before it); the start when there is none before. */
  const goalJump = (dir: -1 | 1): void => {
    const lead = (g: { tick: number }): number => Math.max(0, g.tick - GOAL_LEAD_SECONDS * TICK_RATE);
    const here = pos();
    if (dir > 0) {
      const g = goals.find((x) => lead(x) > here + TICK_RATE / 4);
      if (g) seekTo(lead(g));
    } else {
      let to = 0;
      for (const g of goals) if (lead(g) < here - TICK_RATE / 2) to = lead(g);
      seekTo(to);
    }
  };
  const togglePlay = (): void => {
    previewUntil = -1;
    if (!playing && pos() >= endTick) seekTo(0);
    setPlaying(!playing);
  };

  playBtn.addEventListener('click', togglePlay);
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value) || 1;
  });
  camSel.addEventListener('change', () => setCam(Number(camSel.value) || 0));
  prevGoalBtn.addEventListener('click', () => goalJump(-1));
  nextGoalBtn.addEventListener('click', () => goalJump(1));
  fullscreenBtn.addEventListener('click', () => togglePageFullscreen());
  ballCamBtn.addEventListener('click', () => {
    chase.toggle();
    prefs.ballCam = chase.ballCam;
    saveCamPrefs(prefs);
    updateCamUi();
  });
  distSlider.addEventListener('input', () => {
    chase.settings.distance = Number(distSlider.value) || prefs.chaseDist;
    prefs.chaseDist = chase.settings.distance;
    saveCamPrefs(prefs);
  });
  // The mouse (and a finger) on the picture: the orbital camera turns with a drag, moves its point
  // with the right button or Shift, zooms with the wheel or a pinch; a double click follows the ball again.
  const dom = renderer.gpu.domElement;
  dom.style.touchAction = 'none';
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const pinchSpan = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      dom.setPointerCapture(e.pointerId);
    } catch {
      /* gone */
    }
    if (pointers.size === 2) pinch = pinchSpan();
    if (camIndex === CAM_ORBIT) dom.style.cursor = 'grabbing';
  });
  dom.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || camIndex === 0) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const span = pinchSpan();
      if (pinch > 0 && span > 0) zoomBy(pinch / span);
      pinch = span;
      return;
    }
    if (camIndex !== CAM_ORBIT) return;
    if ((e.buttons & 2) !== 0 || e.shiftKey) {
      // Move the point the camera looks at over the ground (the ground follows the pointer); clamped to the arena where it is used.
      const k = orbit.dist * 0.0016;
      const fx = -Math.cos(orbit.yaw);
      const fz = -Math.sin(orbit.yaw);
      orbit.target.x += fx * dy * k + fz * dx * k;
      orbit.target.z += fz * dy * k - fx * dx * k;
      orbit.follow = false;
    } else {
      orbit.yaw -= dx * 0.005;
      orbit.pitch = clamp(orbit.pitch + dy * 0.005, PITCH_MIN, PITCH_MAX);
    }
  });
  const letGo = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (camIndex === CAM_ORBIT && pointers.size === 0) dom.style.cursor = 'grab';
  };
  dom.addEventListener('pointerup', letGo);
  dom.addEventListener('pointercancel', letGo);
  dom.addEventListener('dblclick', () => {
    if (camIndex === CAM_ORBIT) orbit.follow = true;
  });
  dom.addEventListener(
    'wheel',
    (e) => {
      if (camIndex === 0) return;
      e.preventDefault();
      zoomBy(Math.exp(clamp(e.deltaY, -240, 240) * 0.0012));
    },
    { passive: false },
  );
  seek.addEventListener('pointerdown', () => {
    dragging = true;
  });
  const release = (): void => {
    dragging = false;
  };
  seek.addEventListener('pointerup', release);
  seek.addEventListener('pointercancel', release);
  seek.addEventListener('change', () => {
    dragging = false;
    previewUntil = -1;
    seekTo(Number(seek.value));
  });
  /** The Esc press that will close the menu on its release (performance.now; -1 none): full screen with Esc locked. */
  let escArmedAt = -1;
  window.addEventListener('keydown', (e) => {
    // Alt + ← is the browser's Back, Ctrl / Cmd + a digit its tabs.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Esc pauses and opens the menu (and closes it again); with the menu open nothing else answers.
    // A held key's repeats do nothing; in the game's full screen with Esc locked the close waits
    // for the release, as a held Esc is the browser's way out (src/game/pauseKeys.ts).
    if (e.code === 'Escape') {
      e.preventDefault();
      const act = escMenuAction(menuOpen, e.repeat, escLocked());
      if (act === 'open') {
        if (clipJob !== null) cancelClip();
        else if (!clipPanel.classList.contains('rp-hidden')) closeClipPanel();
        else if (editorOpen) closeEditor();
        else setMenu(true);
      }
      else if (act === 'close') setMenu(false);
      else if (act === 'arm') escArmedAt = performance.now();
      return;
    }
    if (menuOpen || clipJob !== null) return;
    if (e.target instanceof HTMLSelectElement || (e.target instanceof HTMLInputElement && e.target.type !== 'range')) return;
    if (editorOpen) {
      editorKey(e);
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      seekTo(pos() + (e.code === 'ArrowLeft' ? -5 : 5) * TICK_RATE);
    } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      goalJump(e.code === 'BracketLeft' ? -1 : 1);
    } else if (e.code === 'KeyB' && camIndex >= CAM_CAR0) {
      ballCamBtn.click();
    } else if (e.code === 'KeyF') {
      // In the keydown itself (its user activation). With the keyboard lock a short Esc still opens the menu.
      togglePageFullscreen();
    } else if (/^Digit[0-9]$/.test(e.code)) {
      setCam(Number(e.code.slice(5)));
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Escape' || escArmedAt < 0) return;
    const held = performance.now() - escArmedAt;
    escArmedAt = -1;
    if (escArmStep(held, escLocked(), menuOpen) === 'resume') setMenu(false);
  });
  window.addEventListener('blur', () => {
    escArmedAt = -1;
  });

  /** The final whistle's banner (kept until a seek). */
  const showEnd = (winner: number, blue: number, red: number): void => {
    hud.showBanner(winner === 0 || winner === 1 ? t('game.teamWins', { team: TEAM_NAME[winner]() }) : t('game.draw'), `${blue} – ${red}`, 0, winner === 0 || winner === 1 ? winner : null);
  };

  /** The match events of the tick just run, to the HUD; `live` false while seeking (no banners). */
  const onEvents = (live: boolean): void => {
    run.host.takeEvents(events);
    if (!live) return;
    for (const e of events) {
      if (e.type === 'countdown') {
        hud.showCountdown(e.n);
        sound.countdown();
      } else if (e.type === 'go') {
        sound.go();
        hud.showCountdown('GO');
        goHideTick = e.tick + GO_CAPTION_TICKS;
      } else if (e.type === 'kickoff') {
        hud.showCountdown(null);
        goHideTick = -1;
      } else if (e.type === 'overtime') hud.showOvertime();
      else if (e.type === 'goal') {
        const g = goalAt.get(e.tick);
        const scorer = g && g.slot >= 0 ? (shownName[g.slot] ?? null) : null;
        hud.showGoal(e.team, scorer, e.blue, e.red);
        lastGoal = { tick: e.tick, team: e.team, scorer };
        // The game's goal explosion at the ball (Game.onSimGoal): the burst, the confetti, the rings and the flash.
        const b = run.sim.buf;
        goalPos[0] = b[BALL_OFFSET + B_POS];
        goalPos[1] = b[BALL_OFFSET + B_POS + 1];
        goalPos[2] = b[BALL_OFFSET + B_POS + 2];
        effects.onGoal(e.team, goalPos);
        sound.goal(e.team);
      } else if (e.type === 'ended') showEnd(e.winner, e.blue, e.red);
    }
  };

  let hudAt = 0;
  const updateHud = (): void => {
    const m = run.host.match;
    hud.setScore(m.score.blue, m.score.red);
    hud.setClock(m.displaySeconds, m.overtime ? 'overtime' : m.isUnlimited ? 'unlimited' : 'regulation');
    const now = performance.now();
    if (now - hudAt < 100) return;
    hudAt = now;
    // While a seek runs, the thumb and the time show where it goes.
    const T = pos();
    if (!dragging) seek.value = String(T);
    time.textContent = `${clockText(T)} / ${clockText(endTick)}`;
  };

  /** The tags on the frame just drawn: none on the car the camera follows. */
  const placeTags = (): void => {
    for (let i = 0; i < tagRows.length; i++) tagRows[i].bot = !run.host.isHumanSlot(slots[i]);
    tags.update(renderer.camera, tagRows, cars, offsets, cur, ball.position, camIndex >= CAM_CAR0 ? camIndex - CAM_CAR0 : -1, null);
  };

  const draw = (alpha: number, dt: number): void => {
    for (let i = 0; i < cars.length; i++) cars[i].update(prev, cur, offsets[i], alpha, dt);
    ball.update(prev, cur, alpha, dt);
    effects.update(prev, cur, alpha, dt, slots);
    for (let i = 0; i < NUM_BOOST_PADS; i++) {
      const off = PADS_OFFSET + i * PAD_STRIDE;
      arena.setPadState(i, cur[off + P_IS_ACTIVE] > 0.5, cur[off + P_COOLDOWN]);
    }
    arena.update(dt, performance.now() / 1000);

    const camera = renderer.camera;
    const bp = ball.position;
    if (camIndex === 0) {
      // Broadcast: from inside the side wall, high, following the ball along the field (three z = sim y).
      camera.position.set(-3900, 1700, bp.z * 0.75);
      lookAt.set(bp.x * 0.5, Math.min(bp.y, 800) * 0.5, bp.z * 0.9);
      camera.up.set(0, 1, 0);
      camera.lookAt(lookAt);
      if (camera.fov !== 75) {
        camera.fov = 75;
        camera.updateProjectionMatrix();
      }
      snapChase = true;
    } else if (camIndex === CAM_ORBIT) {
      // Orbital: round a point that follows the ball (or the spot the player moved it to). The point and
      // the camera are both kept inside the arena (Camera.ts clampToArena), so it never leaves the stadium.
      if (snapChase) {
        snapChase = false;
        orbit.target.copy(bp);
      } else if (orbit.follow) {
        orbit.target.lerp(bp, 1 - Math.exp(-6 * Math.min(dt, 0.1)));
      }
      clampToArena(orbit.target);
      const cp = Math.cos(orbit.pitch);
      camera.position.set(orbit.target.x + orbit.dist * cp * Math.cos(orbit.yaw), orbit.target.y + orbit.dist * Math.sin(orbit.pitch), orbit.target.z + orbit.dist * cp * Math.sin(orbit.yaw));
      clampToArena(camera.position);
      if (camera.position.y < 60) camera.position.y = 60;
      camera.up.set(0, 1, 0);
      camera.lookAt(orbit.target);
      if (camera.fov !== 75) {
        camera.fov = 75;
        camera.updateProjectionMatrix();
      }
    } else {
      const i = camIndex - CAM_CAR0;
      const po = offsets[i];
      const vx = cur[po + C_VEL];
      const vy = cur[po + C_VEL + 1];
      const vz = cur[po + C_VEL + 2];
      camState.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      camState.grounded = cur[po + C_IS_ON_GROUND] > 0.5;
      camState.supersonic = cur[po + C_IS_SUPERSONIC] > 0.5;
      const car = cars[i];
      if (snapChase) {
        snapChase = false;
        chase.snapTo(camera, car.position, car.quaternion, bp, camState);
      } else {
        chase.update(camera, car.position, car.quaternion, bp, camState, dt);
      }
    }
    renderer.render(performance.now());
    placeTags();
  };

  // ---- leaving: a visible Exit; Esc, or the phone's Back, pauses and opens the menu -------------
  const app = o.bar.parentElement ?? document.body;
  const exitBtn = el('button.rp-btn.rp-exit', { type: 'button', 'aria-label': t('replay.exit') }, el('span.rp-x'), t('replay.exit'));
  const resumeBtn = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.resume')) as HTMLButtonElement;
  const menu = el(
    'div.rp-menu.rp-hidden',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('replay.paused') },
    el('div.rp-menu-panel', null, el('span.rp-eyebrow', null, t('replay.paused')), resumeBtn, el('a.rp-btn', { href: './replay.html' }, t('replay.list')), el('a.rp-btn', { href: './' }, t('replay.back'))),
  );
  app.append(exitBtn, menu);
  // An edge tag stays clear of Exit and of the bar (nametags.css .tg-tags-safe): under them it could
  // not be seen. Both measured from the window's edge, again whenever either changes size (Exit hidden
  // behind the menu keeps its last).
  const tagInsets = (): void => {
    if (exitBtn.offsetHeight > 0) o.tagsRoot.style.setProperty('--tags-inset-top', `${exitBtn.offsetTop + exitBtn.offsetHeight}px`);
    o.tagsRoot.style.setProperty('--tags-inset-bottom', `${o.bar.offsetHeight}px`);
  };
  tagInsets();
  if (typeof ResizeObserver === 'function') {
    const insets = new ResizeObserver(tagInsets);
    insets.observe(exitBtn);
    insets.observe(o.bar);
  }
  let menuOpen = false;
  let resumeOnClose = false;
  const setMenu = (open: boolean): void => {
    if (open === menuOpen) return;
    menuOpen = open;
    menu.classList.toggle('rp-hidden', !open);
    exitBtn.classList.toggle('rp-hidden', open);
    if (open) {
      resumeOnClose = playing;
      setPlaying(false);
      resumeBtn.focus();
    } else if (resumeOnClose) setPlaying(true);
  };
  exitBtn.addEventListener('click', () => setMenu(true));
  resumeBtn.addEventListener('click', () => setMenu(false));
  menu.addEventListener('click', (e) => {
    if (e.target === menu) setMenu(false);
  });
  // The phone's Back (a gesture, the button) and the browser's: the first press pauses and opens the menu,
  // the next one leaves (to the page it came from).
  history.pushState({ tgReplay: 1 }, '');
  window.addEventListener('popstate', () => {
    if (stopped) return;
    if (!menuOpen) {
      setMenu(true);
      history.pushState({ tgReplay: 1 }, '');
    } else history.back();
  });

  // ---- clips and links ------------------------------------------------------------------------
  // The Clip panel: each goal with Watch / Link / Clip, a clip from the current moment, the format.
  // A clip seeks to its start, plays once at 1x with the page's chrome hidden and the canvas in the
  // clip's shape, and records every drawn frame (clip.ts); then a result sheet offers the file.
  const clipSupported = canRecordClips();
  const clipPrefs = loadClipPrefs();
  let clipFormat: ClipFormat = clipPrefs.format;
  let clipQuality: ClipQuality = clipPrefs.quality;
  let clipNames = clipPrefs.names;
  let clipSound = clipPrefs.sound;
  let clipVolume = clipPrefs.volume;
  let clipMusic = clipPrefs.music;
  let clipUrl: string | null = null;
  /** The goal the last event showed: its caption goes on the frames after it (the DOM banner is not recorded). */
  let lastGoal: { tick: number; team: 0 | 1; scorer: string | null } | null = null;
  interface ClipJob {
    phase: 'seek' | 'rec';
    start: number;
    end: number;
    goalTick: number | null;
    rec: ClipRecorder | null;
    savedSpeed: number;
    wait: number;
    thumbAt: number;
  }
  let clipJob: ClipJob | null = null;
  /** The range to record (ticks), and whether the player has set it (otherwise it follows the moment the sheet opens at). */
  let clipRange: { start: number; end: number } | null = null;
  let clipEdited = false;
  /** The tick a range preview stops at (-1: none). */
  let previewUntil = -1;
  let editorOpen = false;
  let onCamChange: (() => void) | null = null;
  const clipPanel = el('div.rp-menu.rp-hidden', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('replay.clipTitle') });
  const recText = el('span.rp-rec-time', null, '');
  const recCancel = el('button.rp-btn', { type: 'button' }, t('replay.clipCancel')) as HTMLButtonElement;
  const recHud = el('div.rp-rec.rp-hidden', null, el('span.rp-rec-dot'), el('span', null, t('replay.clipRecording')), recText, recCancel);
  app.append(clipPanel, recHud);

  const goalLead = (g: { tick: number }): number => Math.max(0, g.tick - GOAL_LEAD_SECONDS * TICK_RATE);
  const linkFor = (tick: number): string | null => (o.matchId === null ? null : shareUrl(location.href, o.matchId, tick));
  /** Copy a link to the moment (the phone's share sheet where it has no clipboard), true when it went. */
  const shareLink = async (tick: number): Promise<boolean> => {
    const url = linkFor(tick);
    if (url === null) return false;
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      try {
        await navigator.share({ url, title: 'Turbogol' });
        return true;
      } catch {
        return false;
      }
    }
  };
  const closeClipPanel = (): void => {
    clipPanel.classList.add('rp-hidden');
    if (clipUrl !== null) {
      URL.revokeObjectURL(clipUrl);
      clipUrl = null;
    }
  };
  /**
   * The canvas at the video's own size in CSS pixels (so the game renders exactly that many pixels:
   * a stage as small as the window gave a blurry video) and scaled down by a transform to fit the window.
   */
  const fitStage = (): void => {
    const f = clipSize(clipFormat, clipQuality);
    const k = Math.min(window.innerWidth / f.w, window.innerHeight / f.h);
    const s = renderer.gpu.domElement.style;
    s.inset = 'auto';
    s.width = `${f.w}px`;
    s.height = `${f.h}px`;
    s.left = `${Math.round((window.innerWidth - f.w * k) / 2)}px`;
    s.top = `${Math.round((window.innerHeight - f.h * k) / 2)}px`;
    s.transformOrigin = '0 0';
    s.transform = `scale(${k})`;
  };
  const enterClipMode = (): void => {
    if (editorOpen) {
      layoutStage();
      return;
    }
    document.body.classList.add('rp-clip');
    fitStage();
  };
  const leaveClipMode = (): void => {
    recHud.classList.add('rp-hidden');
    if (editorOpen) {
      layoutStage();
      return;
    }
    document.body.classList.remove('rp-clip');
    const s = renderer.gpu.domElement.style;
    s.inset = s.left = s.top = s.width = s.height = s.transform = s.transformOrigin = '';
    recHud.classList.add('rp-hidden');
  };
  window.addEventListener('resize', () => {
    if (clipJob !== null && !editorOpen) fitStage();
  });
  const cancelClip = (): void => {
    const job = clipJob;
    if (job === null) return;
    clipJob = null;
    job.rec?.cancel();
    sound.endExport();
    leaveClipMode();
    speed = job.savedSpeed;
    speedSel.value = String(speed);
    setPlaying(false);
  };
  recCancel.addEventListener('click', cancelClip);

  const startClip = (range: { start: number; end: number }, goalTick: number | null): void => {
    closeClipPanel();
    clipJob = { phase: 'seek', start: range.start, end: range.end, goalTick, rec: null, savedSpeed: speed, wait: 8, thumbAt: goalTick === null ? Math.round((range.start + range.end) / 2) : goalTick + Math.round(0.6 * TICK_RATE) };
    speed = 1;
    speedSel.value = '1';
    setPlaying(false);
    lastGoal = null;
    enterClipMode();
    recText.textContent = '';
    recHud.classList.remove('rp-hidden');
    seekTo(range.start);
  };
  /** The frame loop's clip step, once per drawn frame: begin recording when the seek landed, copy the frame, end at the range's end. */
  const clipStep = (now: number): void => {
    const job = clipJob;
    if (job === null) return;
    if (job.phase === 'seek') {
      if (seekTarget >= 0 || restarting) return;
      if (job.wait-- > 0) return;
      try {
        const audioStream = clipSound ? sound.beginExport(clipVolume / 100, clipMusic / 100) : null;
        job.rec = new ClipRecorder(renderer.gpu.domElement, clipFormat, clipQuality, audioStream);
        job.rec.start();
      } catch (e) {
        console.error('clip: cannot record', e);
        cancelClip();
        showClipSheet({ error: t('replay.clipFailed') });
        return;
      }
      job.phase = 'rec';
      setPlaying(true);
      return;
    }
    const rec = job.rec;
    if (rec === null) return;
    const m = run.host.match;
    const tick = run.host.currentTick;
    const age = lastGoal === null ? -1 : (tick - lastGoal.tick) / TICK_RATE;
    const goal = lastGoal !== null && age >= 0 && age < GOAL_CAPTION_SECONDS ? { team: lastGoal.team, scorer: clipNames ? lastGoal.scorer : null, word: t('hud.goal'), age } : null;
    rec.capture(now, { blue: m.score.blue, red: m.score.red, clock: clockText(Math.round(m.displaySeconds * TICK_RATE)), goal, elapsed: (tick - job.start) / TICK_RATE, total: (job.end - job.start) / TICK_RATE, cta: t('replay.clipCta') });
    if (tick >= job.thumbAt) rec.snapshot();
    recText.textContent = `${Math.floor(rec.seconds)} / ${Math.round((job.end - job.start) / TICK_RATE)} s`;
    if (tick >= job.end || tick >= endTick) {
      clipJob = null;
      leaveClipMode();
      speed = job.savedSpeed;
      speedSel.value = String(speed);
      setPlaying(false);
      sound.endExport();
      rec.finish().then(
        (res) => showClipSheet({ result: res, goalTick: job.goalTick, at: job.start }),
        (e: unknown) => {
          console.error('clip: recording failed', e);
          showClipSheet({ error: t('replay.clipFailed') });
        },
      );
    }
  };

  const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
  /** The sheet after a recording: the preview frame, the file and where it can go. */
  function showClipSheet(s: { result?: ClipResult; error?: string; goalTick?: number | null; at?: number }): void {
    const panel = el('div.rp-menu-panel.rp-clip-panel');
    panel.append(el('span.rp-eyebrow', null, t(s.result ? 'replay.clipReady' : 'replay.clipTitle')));
    if (!s.result) {
      panel.append(el('p.rp-clip-note', null, s.error ?? t('replay.clipFailed')));
    } else {
      const r2 = s.result;
      const name = clipFileName(o.matchId, s.goalTick ?? s.at ?? 0, r2.ext);
      if (clipUrl !== null) URL.revokeObjectURL(clipUrl);
      clipUrl = URL.createObjectURL(r2.blob);
      panel.append(el('img.rp-clip-thumb', { alt: '', src: r2.thumb }), el('p.rp-clip-note', null, t('replay.clipMeta', { s: Math.round(r2.seconds), size: mb(r2.blob.size), ext: r2.ext.toUpperCase(), sound: t(r2.sound ? 'replay.clipWithSound' : 'replay.clipNoSound') })));
      const main = el('div.rp-clip-open');
      main.append(el('a.rp-btn.rp-primary', { href: clipUrl, download: name }, t('replay.clipDownload')));
      panel.append(main);
      const file = new File([r2.blob], name, { type: r2.blob.type });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        const share = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.clipShare'));
        share.addEventListener('click', () => {
          navigator.share({ files: [file], title: 'Turbogol' }).catch(() => undefined);
        });
        main.append(share);
      }
      const gt = s.goalTick ?? null;
      if (gt !== null && o.matchId !== null) {
        const link = el('button.rp-btn', { type: 'button' }, t('replay.clipLink')) as HTMLButtonElement;
        link.addEventListener('click', () => {
          void shareLink(gt).then((ok) => {
            link.textContent = t(ok ? 'replay.clipLinkDone' : 'replay.clipLink');
          });
        });
        main.append(link);
      }
      panel.append(el('p.rp-clip-note.rp-clip-dim', null, t('replay.clipHint')));
      const open = el('div.rp-clip-open');
      for (const [label, href] of [
        ['TikTok', 'https://www.tiktok.com/upload'],
        ['Instagram', 'https://www.instagram.com/'],
        ['YouTube Studio', 'https://studio.youtube.com/'],
      ]) {
        open.append(el('a.rp-btn', { href, target: '_blank', rel: 'noopener noreferrer' }, label));
      }
      panel.append(open);
    }
    const close = el('button.rp-btn', { type: 'button' }, t('replay.clipClose'));
    close.addEventListener('click', closeClipPanel);
    panel.append(close);
    clipPanel.replaceChildren(panel);
    clipPanel.classList.remove('rp-hidden');
  }

  // ---- the clip editor --------------------------------------------------------------------------
  // A video editor's layout: the goals on the left, the player in the middle (the canvas in the clip's
  // shape with the scorebug, caption and watermark drawn over it as they will be recorded), the
  // format, quality and camera on the right, and under it all the timeline: the whole match, the clip's
  // range with a handle at each end, the playhead. Export records the range (startClip).
  const edRoot = el('div.rp-ed.rp-hidden', { role: 'dialog', 'aria-label': t('replay.editorTitle') });
  const ovl = document.createElement('canvas');
  ovl.className = 'rp-ed-ovl rp-hidden';
  app.append(ovl, edRoot);
  let edBuilt = false;
  let timeline: ClipTimeline | null = null;
  let edTime: HTMLElement | null = null;
  let edPlay: HTMLButtonElement | null = null;
  let edSum: HTMLElement | null = null;
  let edStage: HTMLElement | null = null;
  let edCam: HTMLSelectElement | null = null;
  const ovlCtx = ovl.getContext('2d');

  const goalIn = (r: { start: number; end: number }): number | null => {
    const g = goals.find((x) => x.tick >= r.start && x.tick <= r.end);
    return g ? g.tick : null;
  };
  /** The size the stage renders at: the clip's own while exporting, the light one while editing. */
  const stageSize = (): { w: number; h: number } => clipSize(clipFormat, clipJob !== null ? clipQuality : 'standard');
  /** The canvas (and the preview overlay over it) at the stage's size in CSS pixels, scaled to fit the stage's box. */
  function layoutStage(): void {
    if (edStage === null) return;
    const f = stageSize();
    const box = edStage.getBoundingClientRect();
    const base = app.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return;
    const k = Math.min(box.width / f.w, box.height / f.h);
    const left = Math.round(box.left - base.left + (box.width - f.w * k) / 2);
    const top = Math.round(box.top - base.top + (box.height - f.h * k) / 2);
    for (const c of [renderer.gpu.domElement, ovl]) {
      const s = c.style;
      s.inset = 'auto';
      s.width = `${f.w}px`;
      s.height = `${f.h}px`;
      s.left = `${left}px`;
      s.top = `${top}px`;
      s.transformOrigin = '0 0';
      s.transform = `scale(${k})`;
    }
    if (ovl.width !== f.w || ovl.height !== f.h) {
      ovl.width = f.w;
      ovl.height = f.h;
    }
  }
  const setRange = (r: { start: number; end: number }, moved: 'start' | 'end' | 'move' | 'set'): void => {
    clipRange = r;
    clipEdited = true;
    timeline?.setRange(r);
    syncSummary();
    previewUntil = -1;
    if (moved === 'end') seekTo(r.end);
    else seekTo(r.start);
  };
  const syncSummary = (): void => {
    if (edSum === null || clipRange === null) return;
    const secs = (clipRange.end - clipRange.start) / TICK_RATE;
    edSum.textContent = t('replay.clipLength', { s: secs.toFixed(1), size: mb(estimateBytes(secs, clipQuality)) });
  };
  /** The editor's per-frame step: the playhead, the time, the Play button and the preview overlay. */
  const editorTick = (): void => {
    const T = pos();
    timeline?.setPlayhead(T, playing);
    if (edTime !== null) edTime.textContent = `${timeText(T)} / ${timeText(endTick)}`;
    if (edPlay !== null) edPlay.textContent = t(playing ? 'replay.pause' : 'replay.play');
    if (ovlCtx !== null && ovl.width > 0) {
      ovlCtx.clearRect(0, 0, ovl.width, ovl.height);
      const m = run.host.match;
      const tick = run.host.currentTick;
      const age = lastGoal === null ? -1 : (tick - lastGoal.tick) / TICK_RATE;
      const goal = lastGoal !== null && age >= 0 && age < GOAL_CAPTION_SECONDS ? { team: lastGoal.team, scorer: clipNames ? lastGoal.scorer : null, word: t('hud.goal'), age } : null;
      const r = clipRange;
      drawOverlay(ovlCtx, ovl.width, ovl.height, { blue: m.score.blue, red: m.score.red, clock: clockText(Math.round(m.displaySeconds * TICK_RATE)), goal, elapsed: r === null ? 0 : (tick - r.start) / TICK_RATE, total: r === null ? 0 : (r.end - r.start) / TICK_RATE, cta: t('replay.clipCta') });
    }
  };

  const buildEditor = (): void => {
    edBuilt = true;
    // header
    const back = el('button.rp-btn', { type: 'button' }, t('replay.editorBack')) as HTMLButtonElement;
    back.addEventListener('click', () => closeEditor());
    const exportBtn = el('button.rp-btn.rp-primary.rp-ed-export', { type: 'button' }, t('replay.editorExport')) as HTMLButtonElement;
    exportBtn.disabled = !clipSupported;
    exportBtn.addEventListener('click', () => {
      sound.unlock();
      if (clipRange !== null) startClip(clipRange, goalIn(clipRange));
    });
    edSum = el('span.rp-ed-sum', null, '');
    // Small screens keep the goals and the settings in a sheet this button opens
    const optsBtn = el('button.rp-btn.rp-ed-optsbtn', { type: 'button', 'aria-expanded': 'false' }, t('replay.editorOptions')) as HTMLButtonElement;
    optsBtn.addEventListener('click', () => optsBtn.setAttribute('aria-expanded', String(edRoot.classList.toggle('rp-ed-opts'))));
    const head = el('header.rp-ed-head', null, back, el('span.rp-ed-title', null, t('replay.editorTitle')), el('span.rp-grow'), edSum, optsBtn, exportBtn);

    // left: the goals
    const status = el('p.rp-clip-note.rp-clip-dim', null, o.matchId === null ? t('replay.clipNoLink') : '');
    const rows = el('div.rp-clip-rows');
    goals.forEach((g, i) => {
      const who = g.slot >= 0 ? (shownName[g.slot] ?? '') : '';
      const row = el('div.rp-clip-row');
      row.append(el(`span.rp-dot.${g.team === 0 ? 'rp-blue' : 'rp-red'}`), el('span.rp-clip-label', null, `${t('replay.clipGoal', { n: i + 1 })} · ${clockText(g.tick)}${who ? ` · ${who}` : ''}`));
      const acts = el('span.rp-clip-acts');
      const use = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.clipUse'));
      use.addEventListener('click', () => {
        setRange(clipWindow(g.tick, endTick), 'set');
        timeline?.showRange();
      });
      const w = el('button.rp-btn', { type: 'button' }, t('replay.clipWatch'));
      w.addEventListener('click', () => {
        previewUntil = -1;
        seekTo(goalLead(g));
        setPlaying(true);
      });
      acts.append(use, w);
      if (o.matchId !== null) {
        const l = el('button.rp-btn', { type: 'button' }, t('replay.clipLink'));
        l.addEventListener('click', () => {
          void shareLink(g.tick).then((ok) => {
            status.textContent = ok ? t('replay.clipLinkDone') : t('replay.clipLinkFailed');
          });
        });
        acts.append(l);
      }
      row.append(acts);
      rows.append(row);
    });
    const left = el('aside.rp-ed-left', null, el('span.rp-clip-sub', null, t('replay.clipGoals')), goals.length > 0 ? rows : el('p.rp-clip-note.rp-clip-dim', null, t('replay.editorNoGoals')), status);

    // centre: the stage and its transport
    edStage = el('div.rp-ed-stage');
    edTime = el('span.rp-ed-time', null, '');
    edPlay = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.play')) as HTMLButtonElement;
    edPlay.addEventListener('click', togglePlay);
    const playClip = el('button.rp-btn', { type: 'button' }, t('replay.editorPlayClip'));
    playClip.addEventListener('click', () => {
      if (clipRange === null) return;
      previewUntil = clipRange.end;
      seekTo(clipRange.start);
      setPlaying(true);
    });
    const center = el('section.rp-ed-center', null, edStage, el('div.rp-ed-transport', null, edTime, el('span.rp-grow'), edPlay, playClip));

    // right: format, quality, camera, options
    const save = (): void => saveClipPrefs({ format: clipFormat, quality: clipQuality, names: clipNames, sound: clipSound, volume: clipVolume, music: clipMusic });
    const chips = <K extends string>(label: string, items: Array<[K, string]>, get: () => K, set: (k: K) => void): HTMLElement[] => {
      const group = el('div.rp-fgroup', { role: 'radiogroup', 'aria-label': label });
      for (const [key, text] of items) {
        const b = el('button.rp-fchip', { type: 'button', role: 'radio', 'aria-pressed': String(get() === key) }, text) as HTMLButtonElement;
        b.addEventListener('click', () => {
          set(key);
          save();
          for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
          syncSummary();
          layoutStage();
        });
        group.append(b);
      }
      return [el('span.rp-clip-sub', null, label), group];
    };
    edCam = el('select.rp-btn', { 'aria-label': t('replay.camera') }) as HTMLSelectElement;
    for (const opt of camSel.querySelectorAll('option')) edCam.append(opt.cloneNode(true));
    edCam.value = camSel.value;
    edCam.addEventListener('change', () => setCam(Number(edCam?.value) || 0));
    onCamChange = (): void => {
      if (edCam !== null) edCam.value = camSel.value;
    };
    const names = el('input', { type: 'checkbox' }) as HTMLInputElement;
    names.checked = clipNames;
    names.addEventListener('change', () => {
      clipNames = names.checked;
      save();
    });
    const sndOn = el('input', { type: 'checkbox' }) as HTMLInputElement;
    sndOn.checked = clipSound;
    sndOn.addEventListener('change', () => {
      clipSound = sndOn.checked;
      save();
      for (const r2 of sndRows) r2.classList.toggle('rp-disabled', !clipSound);
    });
    const slider = (label: string, get: () => number, set: (v: number) => void): HTMLElement => {
      const val = el('b.rp-clip-time', null, `${get()}%`);
      const input = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(get()), 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('input', () => {
        set(Number(input.value));
        val.textContent = `${input.value}%`;
        save();
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return el('div.rp-ed-slider', null, el('span.rp-clip-note', null, label), input, val);
    };
    const sndRows = [slider(t('replay.clipVolume'), () => clipVolume, (v) => (clipVolume = v)), slider(t('replay.clipMusic'), () => clipMusic, (v) => (clipMusic = v))];
    for (const r2 of sndRows) r2.classList.toggle('rp-disabled', !clipSound);
    const soundControls = [el('span.rp-clip-sub', null, t('replay.clipSoundTitle')), el('label.rp-clip-check', null, sndOn, t('replay.clipSound')), ...sndRows];
    const right = el(
      'aside.rp-ed-right',
      null,
      ...chips<ClipFormat>(t('replay.clipFormat'), [['vertical', t('replay.clipVertical')], ['square', '1:1'], ['wide', '16:9']], () => clipFormat, (k) => (clipFormat = k)),
      ...chips<ClipQuality>(t('replay.clipQuality'), [['standard', t('replay.clipQStandard')], ['high', t('replay.clipQHigh')], ['max', t('replay.clipQMax')]], () => clipQuality, (k) => (clipQuality = k)),
      el('p.rp-clip-note.rp-clip-dim', null, t('replay.clipQualityHint')),
      el('span.rp-clip-sub', null, t('replay.camera')),
      edCam,
      el('label.rp-clip-check', null, names, t('replay.clipNames')),
      ...soundControls,
      clipSupported ? null : el('p.rp-clip-note', null, t('replay.clipUnsupported')),
    );

    // bottom: the tools and the timeline
    const tl = new ClipTimeline({
      endTick,
      goals: goals.map((g) => ({ tick: g.tick, team: g.team })),
      onSeek: (tick) => {
        previewUntil = -1;
        seekTo(tick);
      },
      onRange: (r, moved) => setRange(r, moved),
    });
    timeline = tl;
    const tool = (label: string, key: string, fn: () => void): HTMLButtonElement => {
      const b = el('button.rp-btn.rp-tool', { type: 'button' }, label, key ? el('kbd', null, key) : null) as HTMLButtonElement;
      b.addEventListener('click', fn);
      return b;
    };
    const setEdge = (edge: 'start' | 'end'): void => {
      if (clipRange === null) return;
      const T = pos();
      setRange(edge === 'start' ? clampClipRange(T, clipRange.end, endTick, 'start') : clampClipRange(clipRange.start, T, endTick, 'end'), edge);
    };
    editorSetEdge = setEdge;
    const zoomSlider = el('input', { type: 'range', min: '0', max: '100', step: '1', value: '0', 'aria-label': t('replay.editorZoom') }) as HTMLInputElement;
    zoomSlider.addEventListener('input', () => tl.setZoom(Math.pow(tl.maxZoom, Number(zoomSlider.value) / 100)));
    const tools = el(
      'div.rp-ed-tools',
      null,
      tool(t('replay.editorSetStart'), 'I', () => setEdge('start')),
      tool(t('replay.editorSetEnd'), 'O', () => setEdge('end')),
      tool(t('replay.prevGoal'), '', () => goalJump(-1)),
      tool(t('replay.nextGoal'), '', () => goalJump(1)),
      el('span.rp-grow'),
      tool(t('replay.editorFit'), '', () => {
        tl.fit();
        zoomSlider.value = '0';
      }),
      el('span.rp-ed-zoomlabel', null, t('replay.editorZoom')),
      zoomSlider,
    );
    const bottom = el('footer.rp-ed-tl', null, tools, tl.root);
    edRoot.replaceChildren(head, el('div.rp-ed-panels', null, left, right), center, bottom);
    new ResizeObserver(() => layoutStage()).observe(edStage);
  };
  let editorSetEdge: (edge: 'start' | 'end') => void = () => undefined;

  const openEditor = (): void => {
    setPlaying(false);
    previewUntil = -1;
    if (clipRange === null || !clipEdited) clipRange = defaultClipRange(pos(), goals.map((g) => g.tick), endTick);
    if (!edBuilt) buildEditor();
    editorOpen = true;
    document.body.classList.add('rp-editing');
    edRoot.classList.remove('rp-hidden');
    ovl.classList.remove('rp-hidden');
    if (edCam !== null) edCam.value = camSel.value;
    timeline?.layout();
    timeline?.setRange(clipRange);
    timeline?.showRange();
    syncSummary();
    layoutStage();
    seekTo(clipRange.start);
  };
  function closeEditor(): void {
    if (clipJob !== null) cancelClip();
    editorOpen = false;
    document.body.classList.remove('rp-editing');
    edRoot.classList.add('rp-hidden');
    ovl.classList.add('rp-hidden');
    const s = renderer.gpu.domElement.style;
    s.inset = s.left = s.top = s.width = s.height = s.transform = s.transformOrigin = '';
    previewUntil = -1;
    setPlaying(false);
  }
  const editorKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 5 : 1;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      previewUntil = -1;
      seekTo(pos() + (e.code === 'ArrowLeft' ? -step : step) * TICK_RATE);
    } else if (e.code === 'KeyI') editorSetEdge('start');
    else if (e.code === 'KeyO') editorSetEdge('end');
    else if (e.code === 'Home' && clipRange !== null) seekTo(clipRange.start);
    else if (e.code === 'End' && clipRange !== null) seekTo(clipRange.end);
    else if (e.code === 'BracketLeft' || e.code === 'BracketRight') goalJump(e.code === 'BracketLeft' ? -1 : 1);
  };
  clipBtn.addEventListener('click', openEditor);
  clipPanel.addEventListener('click', (e) => {
    if (e.target === clipPanel) closeClipPanel();
  });
  if (o.startTick !== null) seekTo(Math.max(0, Math.min(endTick, o.startTick) - GOAL_LEAD_SECONDS * TICK_RATE));

  updateCamUi();
  let stopped = false;
  const frame = (now: number): void => {
    if (stopped) return;
    requestAnimationFrame(frame);
    const dt = last < 0 ? 0 : Math.min(MAX_FRAME_DT, (now - last) / 1000);
    last = now;
    if (restarting) return;
    if (seekTarget >= 0) {
      const t0 = performance.now();
      while (run.host.currentTick < seekTarget && performance.now() - t0 < BUSY_BUDGET_MS) {
        step(run, r);
        onEvents(false);
        takeState();
      }
      if (run.host.currentTick >= seekTarget) {
        seekTarget = -1;
        prev.set(cur);
        snapChase = true;
        hud.showCountdown(null);
        hud.hideBanner();
        goHideTick = -1;
        // A seek to the end lands after the whistle: its banner, which the fast-forward did not show.
        const m = run.host.match;
        if (run.host.ended) showEnd(m.winner ?? -1, m.score.blue, m.score.red);
        if (run.host.currentTick >= endTick) setPlaying(false);
      }
      acc = 0;
    } else if (playing) {
      acc += dt * speed;
      liveStep = true;
      while (acc >= TICK_DT && run.host.currentTick < endTick) {
        step(run, r);
        onEvents(true);
        takeState();
        acc -= TICK_DT;
        if (goHideTick >= 0 && run.host.currentTick >= goHideTick) {
          hud.showCountdown(null);
          goHideTick = -1;
        }
      }
      liveStep = false;
      if (run.host.currentTick >= endTick) {
        acc = 0;
        setPlaying(false);
      }
    }
    // The tier's frame cap (super low: 30 fps, as in the game): the sim keeps its time, the drawing skips.
    if (!drawsFrame(now, lastDrawn, renderer.spec.maxFps)) return;
    const drawDt = lastDrawn < 0 ? dt : Math.min(MAX_FRAME_DT, (now - lastDrawn) / 1000);
    lastDrawn = now;
    draw(seekTarget >= 0 || !playing ? 1 : acc / TICK_DT, playing && seekTarget < 0 ? drawDt * speed : 0);
    updateHud();
    soundStep(drawDt);
    clipStep(now);
    if (previewUntil >= 0 && playing && seekTarget < 0 && !restarting && run.host.currentTick >= previewUntil) {
      previewUntil = -1;
      setPlaying(false);
    }
    if (editorOpen) editorTick();
  };
  requestAnimationFrame(frame);
  return () => {
    stopped = true;
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(ev, unlockSound);
    sound.dispose();
  };
}
