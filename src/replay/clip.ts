/**
 * Clips of a replay: a goal (or any stretch) recorded from the viewer's own canvas into a video the
 * player can post to TikTok, Instagram Reels, YouTube Shorts, WhatsApp or Discord, and a link to the
 * moment. All of it runs in the player's browser: nothing is uploaded, no server, no account, no
 * platform API (those ask for an audit before they publish in public).
 *
 * The recorder copies every drawn frame of the game canvas into its own 2D canvas (the chosen
 * format, with a small scorebug, the goal caption and a TURBOGOL watermark) and records that one
 * with `captureStream` + `MediaRecorder`. MP4 (H.264) where the browser writes it (Chrome / Edge 130+,
 * Safari), WebM elsewhere (Firefox). The video has no sound: the platforms add the player's music.
 */
import { TICK_RATE } from '../sim/types';

/** The lead before a goal and the tail after it a clip keeps (s), and the longest clip (s). */
export const CLIP_LEAD_SECONDS = 4;
export const CLIP_TAIL_SECONDS = 3;
export const CLIP_MAX_SECONDS = 60;
/** The shortest clip (s). */
export const CLIP_MIN_SECONDS = 1;
/** The length of a clip made "from here" (s). */
export const CLIP_HERE_SECONDS = 10;

export type ClipFormat = 'vertical' | 'square' | 'wide';

/** The shape of each format at 720p; a quality scales it (clipSize). */
export const CLIP_FORMATS: Readonly<Record<ClipFormat, { w: number; h: number }>> = {
  vertical: { w: 720, h: 1280 },
  square: { w: 720, h: 720 },
  wide: { w: 1280, h: 720 },
};

/**
 * What the player picks: the size, the frame rate and the bit rate of the video. Standard is light
 * on a weak device; High and Max render the stage at 1080p and ask more of the GPU and the encoder.
 */
export type ClipQuality = 'standard' | 'high' | 'max';
export const CLIP_QUALITIES: Readonly<Record<ClipQuality, { scale: number; fps: number; bitrate: number }>> = {
  standard: { scale: 1, fps: 30, bitrate: 5_000_000 },
  high: { scale: 1.5, fps: 30, bitrate: 10_000_000 },
  max: { scale: 1.5, fps: 60, bitrate: 16_000_000 },
};

/** The video's size in pixels (even numbers: the encoders need them). */
export function clipSize(format: ClipFormat, quality: ClipQuality): { w: number; h: number } {
  const f = CLIP_FORMATS[format];
  const k = CLIP_QUALITIES[quality].scale;
  return { w: Math.round((f.w * k) / 2) * 2, h: Math.round((f.h * k) / 2) * 2 };
}

const MIME_CANDIDATES: ReadonlyArray<{ mime: string; ext: 'mp4' | 'webm' }> = [
  // H.264 High profile (level 4.2 / 4.0: 1080p at 60 / 30 fps) first: better quality at the same bit rate than the baseline one
  { mime: 'video/mp4;codecs=avc1.64002A', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1.640028', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

/** The first container + codec the browser can record (MP4 first: what every platform takes), null when none. */
export function pickMime(isSupported: (mime: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } | null {
  for (const c of MIME_CANDIDATES) if (isSupported(c.mime)) return c;
  return null;
}

/** The tick range of a clip around a goal, clamped to the match and to CLIP_MAX_SECONDS. */
export function clipWindow(goalTick: number, endTick: number, rate: number = TICK_RATE): { start: number; end: number } {
  const start = Math.max(0, Math.round(goalTick - CLIP_LEAD_SECONDS * rate));
  const end = Math.min(endTick, Math.round(goalTick + CLIP_TAIL_SECONDS * rate), start + CLIP_MAX_SECONDS * rate);
  return { start, end: Math.max(start + rate, end) };
}

/** A clip "from here": CLIP_HERE_SECONDS from the current tick, or the last ones of the match. */
export function clipFrom(tick: number, endTick: number, rate: number = TICK_RATE): { start: number; end: number } {
  const len = CLIP_HERE_SECONDS * rate;
  const end = Math.min(endTick, Math.max(0, Math.round(tick)) + len);
  return { start: Math.max(0, end - len), end };
}

/**
 * The range after one end moved: inside the match, at least CLIP_MIN_SECONDS and at most
 * CLIP_MAX_SECONDS long; the end that did not move gives way when the length is out of bounds.
 */
export function clampClipRange(start: number, end: number, endTick: number, moved: 'start' | 'end', rate: number = TICK_RATE): { start: number; end: number } {
  const min = CLIP_MIN_SECONDS * rate;
  const max = CLIP_MAX_SECONDS * rate;
  const last = Math.max(endTick, min);
  let s = Math.round(Math.min(Math.max(0, start), last - min));
  let e = Math.round(Math.min(Math.max(end, min), last));
  if (moved === 'start') {
    if (e - s < min) e = Math.min(last, s + min);
    if (e - s > max) e = s + max;
  } else {
    if (e - s < min) s = Math.max(0, e - min);
    if (e - s > max) s = e - max;
  }
  return { start: s, end: e };
}

/** The range the sheet opens with: the goal's window the viewer is in or about to reach, the last goal's, or ten seconds from here. */
export function defaultClipRange(here: number, goalTicks: readonly number[], endTick: number, rate: number = TICK_RATE): { start: number; end: number } {
  const sorted = [...goalTicks].sort((a, b) => a - b);
  const windows = sorted.map((g) => clipWindow(g, endTick, rate));
  const inside = windows.find((w) => here >= w.start && here <= w.end);
  if (inside) return inside;
  const next = windows.find((w) => w.start > here);
  if (next) return next;
  return windows.length > 0 ? windows[windows.length - 1] : clipFrom(here, endTick, rate);
}

/** A time as m:ss.d (the range's sliders). */
export function timeText(ticks: number, rate: number = TICK_RATE): string {
  const s = Math.max(0, ticks) / rate;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/** About how many bytes a clip of `seconds` takes at a quality (its bit rate; the encoder lands within ~25%). */
export function estimateBytes(seconds: number, quality: ClipQuality): number {
  return (CLIP_QUALITIES[quality].bitrate * Math.max(0, seconds)) / 8;
}

/** Where the goal's link goes: this page with the match and the tick (replay.html?id=..&t=..). */
export function shareUrl(page: string, matchId: string, tick: number): string {
  const u = new URL(page);
  u.search = '';
  u.hash = '';
  u.searchParams.set('id', matchId);
  u.searchParams.set('t', String(Math.max(0, Math.round(tick))));
  return u.toString();
}

/** The tick a link asks for (?t=): a plain whole number of at most 8 digits, else null. */
export function parseStartTick(search: string): number | null {
  const v = new URLSearchParams(search).get('t');
  if (v === null || !/^[0-9]{1,8}$/.test(v)) return null;
  return Number(v);
}

/** A file name for a clip: turbogol-gol-<match>-<m>m<ss>s.mp4 (no player names in it). */
export function clipFileName(matchId: string | null, tick: number, ext: string, rate: number = TICK_RATE): string {
  const s = Math.max(0, Math.floor(tick / rate));
  const id = matchId !== null && /^[0-9a-f]{64}$/.test(matchId) ? `${matchId.slice(0, 8)}-` : '';
  return `turbogol-${id}${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s.${ext}`;
}

/** The largest box of `w:h` that fits the window, centred (CSS px). */
export function fitBox(winW: number, winH: number, w: number, h: number): { left: number; top: number; width: number; height: number } {
  const k = Math.min(winW / w, winH / h);
  const width = Math.max(1, Math.floor(w * k));
  const height = Math.max(1, Math.floor(h * k));
  return { left: Math.floor((winW - width) / 2), top: Math.floor((winH - height) / 2), width, height };
}

const BLUE = '#3a9bff';
const RED = '#e83050';
const LIME = '#c6ff2e';
const FONT = `'TG Display', 'Bahnschrift', 'Arial Narrow', system-ui, sans-serif`;

/** What the overlay draws on a frame. */
export interface ClipOverlay {
  blue: number;
  red: number;
  /** The match clock as shown ('2:41'). */
  clock: string;
  /** The goal caption: the scoring team, the scorer's name (null: no name), the word and the seconds since the goal; null none. */
  goal: { team: 0 | 1; scorer: string | null; word: string; age: number } | null;
}

/** How long the goal caption stays (s); it leaves over its last 0.4 s. */
export const GOAL_CAPTION_SECONDS = 2.8;

const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * The goal caption's motion `age` seconds after the goal: the word drops in big and bounces to its
 * size, tilted, pulsing; a ring and spokes burst out from it; the frame shakes, punches in and
 * flashes in the team's colour for the first moments; the name's letters pop in one after another.
 */
export function goalAnim(age: number): { scale: number; alpha: number; rot: number; ring: number; ringAlpha: number; flash: number; shake: number; punch: number } {
  const a = Math.max(0, age);
  const into = clamp01(a / 0.32);
  const out = clamp01((a - (GOAL_CAPTION_SECONDS - 0.4)) / 0.4);
  const pulse = 1 + 0.025 * Math.sin(a * 14) * clamp01(a / 0.5);
  const rk = clamp01(a / 0.6);
  return {
    scale: (2.6 - 1.6 * easeOutBack(into)) * pulse * (1 + 0.15 * out),
    alpha: clamp01(a / 0.1) * (1 - out),
    rot: -0.05 + 0.1 * Math.pow(1 - into, 2),
    ring: 1 - Math.pow(1 - rk, 3),
    ringAlpha: Math.pow(1 - rk, 1.5) * 0.9,
    flash: Math.max(0, 1 - a / 0.3) * 0.38,
    shake: a < 0.45 ? Math.pow(1 - a / 0.45, 2) : 0,
    punch: 1 + 0.07 * Math.exp(-a * 7),
  };
}

function drawGoal(ctx: CanvasRenderingContext2D, w: number, h: number, u: number, g: NonNullable<ClipOverlay['goal']>): void {
  const an = goalAnim(g.age);
  const color = g.team === 0 ? BLUE : RED;
  const cy = h * 0.27;
  const sx = Math.sin(g.age * 95) * 14 * u * an.shake;
  const sy = Math.cos(g.age * 83) * 10 * u * an.shake;
  // flash over the whole frame
  if (an.flash > 0) {
    ctx.globalAlpha = an.flash;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  // ring and spokes from the word's centre
  if (an.ringAlpha > 0.01) {
    const r = an.ring * w * 0.62;
    ctx.save();
    ctx.translate(w / 2 + sx, cy + sy);
    ctx.globalAlpha = an.ringAlpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 14 * u * (1 - an.ring * 0.7);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = LIME;
    ctx.lineWidth = 7 * u;
    ctx.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2 + g.age * 0.8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r * 0.78, Math.sin(ang) * r * 0.78);
      ctx.lineTo(Math.cos(ang) * r * 1.02, Math.sin(ang) * r * 1.02);
      ctx.stroke();
    }
    ctx.restore();
  }
  // the word on its slab
  const word = g.word.toUpperCase();
  let fs = 104 * u;
  ctx.font = `italic 900 ${fs}px ${FONT}`;
  const maxW = w * 0.8;
  const tw0 = ctx.measureText(word).width;
  if (tw0 > maxW) {
    fs *= maxW / tw0;
    ctx.font = `italic 900 ${fs}px ${FONT}`;
  }
  const tw = ctx.measureText(word).width;
  ctx.save();
  ctx.globalAlpha = an.alpha;
  ctx.translate(w / 2 + sx, cy + sy);
  ctx.rotate(an.rot);
  ctx.scale(an.scale, an.scale);
  const slabW = tw + 90 * u;
  const slabH = fs * 1.5;
  const skew = 0.22 * slabH;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 22 * u;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-slabW / 2 + skew, -slabH / 2);
  ctx.lineTo(slabW / 2 + skew, -slabH / 2);
  ctx.lineTo(slabW / 2 - skew, slabH / 2);
  ctx.lineTo(-slabW / 2 - skew, slabH / 2);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = LIME;
  ctx.beginPath();
  ctx.moveTo(-slabW / 2 - skew * 0.55, slabH / 2 - 12 * u);
  ctx.lineTo(slabW / 2 - skew * 0.55 + 0 * u, slabH / 2 - 12 * u);
  ctx.lineTo(slabW / 2 - skew, slabH / 2);
  ctx.lineTo(-slabW / 2 - skew, slabH / 2);
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10 * u;
  ctx.strokeStyle = 'rgba(5, 7, 13, 0.7)';
  ctx.strokeText(word, 0, -4 * u);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(word, 0, -4 * u);
  ctx.restore();
  // the scorer's name: a dark chip with the team's bar, the letters popping in one by one
  if (g.scorer !== null) {
    const name = g.scorer.toUpperCase();
    const nf = 58 * u;
    ctx.font = `italic 900 ${nf}px ${FONT}`;
    const nw = ctx.measureText(name).width;
    const chipW = nw + 86 * u;
    const chipH = nf * 1.55;
    const ny = cy + (slabH / 2) * 1.02 + 46 * u + sy;
    const chipIn = clamp01((g.age - 0.12) / 0.25);
    ctx.save();
    ctx.globalAlpha = an.alpha * chipIn;
    ctx.translate(w / 2 + sx, ny + (1 - easeOutBack(chipIn)) * 40 * u);
    ctx.fillStyle = 'rgba(8, 11, 20, 0.88)';
    ctx.fillRect(-chipW / 2, -chipH / 2, chipW, chipH);
    ctx.fillStyle = color;
    ctx.fillRect(-chipW / 2, -chipH / 2, 14 * u, chipH);
    ctx.fillStyle = LIME;
    ctx.fillRect(-chipW / 2, chipH / 2 - 6 * u, chipW, 6 * u);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = -nw / 2 + 8 * u;
    for (let i = 0; i < name.length; i++) {
      const ch = name[i];
      const cw = ctx.measureText(ch).width;
      const k = clamp01((g.age - 0.18 - i * 0.035) / 0.28);
      if (k > 0) {
        const e = easeOutBack(k);
        ctx.save();
        ctx.translate(x + cw / 2, 2 * u);
        ctx.scale(e, e);
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = an.alpha * chipIn * clamp01(k * 3);
        ctx.fillText(ch, -cw / 2, 0);
        ctx.restore();
      }
      x += cw;
    }
    ctx.restore();
  }
}

/** The clip's own scorebug, goal caption and watermark, sized from the frame's height. */
export function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, o: ClipOverlay): void {
  const u = Math.min(w, h) / 720;
  ctx.save();
  ctx.textBaseline = 'middle';
  // Scorebug, top centre.
  const bw = 330 * u;
  const bh = 62 * u;
  const bx = (w - bw) / 2;
  const by = Math.max(20 * u, h * 0.04);
  ctx.fillStyle = 'rgba(8, 11, 20, 0.78)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = BLUE;
  ctx.fillRect(bx, by, 9 * u, bh);
  ctx.fillStyle = RED;
  ctx.fillRect(bx + bw - 9 * u, by, 9 * u, bh);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = `italic 900 ${40 * u}px ${FONT}`;
  ctx.fillText(String(o.blue), bx + 62 * u, by + bh / 2 + 2 * u);
  ctx.fillText(String(o.red), bx + bw - 62 * u, by + bh / 2 + 2 * u);
  ctx.font = `800 ${26 * u}px ${FONT}`;
  ctx.fillText(o.clock, w / 2, by + bh / 2 + 1 * u);
  // Goal caption, upper third: a team-coloured flash, a ring and spokes bursting out, the word on a
  // slab (drops in big, bounces, tilts, pulses) and the scorer's name popping in letter by letter.
  if (o.goal !== null) drawGoal(ctx, w, h, u, o.goal);
  // Watermark, bottom centre: the game's name and where to find it.
  const wy = h - Math.max(34 * u, h * 0.05);
  ctx.font = `italic 900 ${40 * u}px ${FONT}`;
  const a = 'TURBO';
  const b = 'GOL';
  const aw = ctx.measureText(a).width;
  const bwd = ctx.measureText(b).width;
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 8 * u;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(a, (w - aw - bwd) / 2, wy);
  ctx.fillStyle = LIME;
  ctx.fillText(b, (w - aw - bwd) / 2 + aw, wy);
  ctx.textAlign = 'center';
  ctx.font = `700 ${20 * u}px ${FONT}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillText('turbo-gol.com', w / 2, wy + 34 * u);
  ctx.restore();
}

/** What a finished recording gives. */
export interface ClipResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  /** A JPEG data URL of one frame (the preview: a video preview would need blob: in the page's media-src). */
  thumb: string;
  seconds: number;
}

/** Whether this browser can record a clip at all (MediaRecorder, canvas capture and a container). */
export function canRecordClips(): boolean {
  return typeof MediaRecorder === 'function' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && pickMime((m) => MediaRecorder.isTypeSupported(m)) !== null;
}

export class ClipRecorder {
  private readonly out: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rec: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly ext: 'mp4' | 'webm';
  private readonly mime: string;
  private readonly stopped: Promise<void>;
  private startedAt = 0;
  private lastDraw = -1;
  private thumb = '';
  private failed: unknown = null;

  private readonly source: HTMLCanvasElement;
  private readonly fps: number;

  constructor(source: HTMLCanvasElement, format: ClipFormat, quality: ClipQuality = 'standard') {
    const q = CLIP_QUALITIES[quality];
    const fps = q.fps;
    this.source = source;
    this.fps = fps;
    const pick = pickMime((m) => MediaRecorder.isTypeSupported(m));
    if (pick === null) throw new Error('no recordable video format');
    this.ext = pick.ext;
    this.mime = pick.mime;
    const f = clipSize(format, quality);
    this.out = document.createElement('canvas');
    this.out.width = f.w;
    this.out.height = f.h;
    const c = this.out.getContext('2d');
    if (c === null) throw new Error('no 2D canvas');
    this.ctx = c;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.fillStyle = '#05070d';
    this.ctx.fillRect(0, 0, f.w, f.h);
    this.rec = new MediaRecorder(this.out.captureStream(fps), { mimeType: pick.mime, videoBitsPerSecond: q.bitrate });
    this.rec.ondataavailable = (e): void => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.onerror = (e): void => {
      this.failed = e;
    };
    this.stopped = new Promise((res) => {
      this.rec.onstop = (): void => res();
    });
  }

  start(): void {
    this.startedAt = performance.now();
    this.rec.start(250);
  }

  /** Copy the game canvas as it is now (cover-fitted to the clip's shape) and put the overlay over it; at most `fps` a second. */
  capture(now: number, overlay: ClipOverlay): void {
    if (this.lastDraw >= 0 && now - this.lastDraw < 1000 / this.fps - 2) return;
    this.lastDraw = now;
    const { width: w, height: h } = this.out;
    const sw = this.source.width;
    const sh = this.source.height;
    if (sw === 0 || sh === 0) return;
    const k = Math.max(w / sw, h / sh);
    const cw = w / k;
    const ch = h / k;
    // The game frame punches in and shakes for a moment after a goal (goalAnim); the overlay does not.
    const g = overlay.goal;
    const an = g === null ? null : goalAnim(g.age);
    const u = Math.min(w, h) / 720;
    const dw = w * (an?.punch ?? 1);
    const dh = h * (an?.punch ?? 1);
    const shx = g === null || an === null ? 0 : Math.sin(g.age * 95) * 14 * u * an.shake;
    const shy = g === null || an === null ? 0 : Math.cos(g.age * 83) * 10 * u * an.shake;
    this.ctx.drawImage(this.source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, (w - dw) / 2 + shx, (h - dh) / 2 + shy, dw, dh);
    drawOverlay(this.ctx, w, h, overlay);
  }

  /** Keep the current frame as the preview (the first one asked for: the goal moment). */
  snapshot(): void {
    if (this.thumb === '') this.thumb = this.out.toDataURL('image/jpeg', 0.82);
  }

  get seconds(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  async finish(): Promise<ClipResult> {
    const seconds = this.seconds;
    if (this.rec.state !== 'inactive') this.rec.stop();
    await this.stopped;
    if (this.failed !== null) throw new Error('the recorder failed');
    if (this.thumb === '') this.snapshot();
    const blob = new Blob(this.chunks, { type: this.mime.split(';')[0] });
    if (blob.size === 0) throw new Error('empty recording');
    return { blob, ext: this.ext, thumb: this.thumb, seconds };
  }

  cancel(): void {
    this.rec.ondataavailable = null;
    this.rec.onerror = null;
    if (this.rec.state !== 'inactive') this.rec.stop();
    for (const tr of (this.rec.stream as MediaStream).getTracks()) tr.stop();
  }
}
