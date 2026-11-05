/**
 * The clip editor's timeline (player.ts): a ruler, a strip of the whole match with its goals, the
 * clip's range with a handle at each end (drag an end to trim, drag the body to move it) and the
 * playhead (click or drag the ruler or the strip to scrub). Zoom with the buttons, Ctrl + wheel or
 * pinch-less: the strip scrolls sideways. All in ticks; the player owns the state and the moments.
 */
import { TICK_RATE } from '../sim/types';
import { clampClipRange, moveClipRange, rulerStep, timeText } from './clip';
import { el } from './list';

export interface TimelineGoal {
  tick: number;
  team: 0 | 1;
}

export interface TimelineOptions {
  endTick: number;
  goals: readonly TimelineGoal[];
  /** The playhead was clicked or dragged to a moment. */
  onSeek(tick: number): void;
  /** A range end or the whole range was dragged. */
  onRange(range: { start: number; end: number }, moved: 'start' | 'end' | 'move'): void;
}

const PAD = 14;
const MAX_ZOOM = 24;

type Drag = { kind: 'scrub' } | { kind: 'start' | 'end' } | { kind: 'move'; x0: number; start0: number; end0: number; moved: boolean };

export class ClipTimeline {
  readonly root: HTMLElement;
  private readonly o: TimelineOptions;
  private readonly scroll: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly ruler: HTMLElement;
  private readonly track: HTMLElement;
  private readonly region: HTMLElement;
  private readonly regionLabel: HTMLElement;
  private readonly head: HTMLElement;
  private readonly seconds: number;
  private zoomK = 1;
  private range: { start: number; end: number } | null = null;
  private drag: Drag | null = null;
  private playTick = 0;

  constructor(o: TimelineOptions) {
    this.o = o;
    this.seconds = Math.max(1, o.endTick / TICK_RATE);
    this.ruler = el('div.tl-ruler');
    this.track = el('div.tl-track');
    this.regionLabel = el('span.tl-region-label');
    this.region = el('div.tl-region.rp-hidden', null, el('i.tl-handle.tl-h-start', { 'data-h': 'start', title: '' }), this.regionLabel, el('i.tl-handle.tl-h-end', { 'data-h': 'end', title: '' }));
    this.head = el('div.tl-playhead', null, el('i.tl-playhead-cap'));
    for (const g of o.goals) {
      const m = el(`i.tl-goal.${g.team === 0 ? 'tl-blue' : 'tl-red'}`);
      m.dataset.tick = String(g.tick);
      this.track.append(m);
    }
    this.track.append(this.region);
    this.inner = el('div.tl-inner', null, this.ruler, this.track, this.head);
    this.scroll = el('div.tl-scroll', null, this.inner);
    this.root = el('div.tl', null, this.scroll);
    this.inner.addEventListener('pointerdown', (e) => this.down(e));
    this.inner.addEventListener('pointermove', (e) => this.move(e));
    this.inner.addEventListener('pointerup', (e) => this.up(e));
    this.inner.addEventListener('pointercancel', (e) => this.up(e));
    this.scroll.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX);
        } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          this.scroll.scrollLeft += e.deltaY;
        }
      },
      { passive: false },
    );
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.layout()).observe(this.scroll);
  }

  /** CSS pixels per second at the current zoom (zoom 1 fits the whole match in the view). */
  get pxPerSecond(): number {
    const fit = Math.max(1, (this.scroll.clientWidth - 2 * PAD) / this.seconds);
    return fit * this.zoomK;
  }
  get zoom(): number {
    return this.zoomK;
  }
  get maxZoom(): number {
    return MAX_ZOOM;
  }

  private x(tick: number): number {
    return PAD + (tick / TICK_RATE) * this.pxPerSecond;
  }
  private tickAt(clientX: number): number {
    const r = this.inner.getBoundingClientRect();
    const t = ((clientX - r.left - PAD) / this.pxPerSecond) * TICK_RATE;
    return Math.round(Math.min(this.o.endTick, Math.max(0, t)));
  }

  /** Rebuild the ruler and place everything for the current size and zoom. */
  layout(): void {
    const pps = this.pxPerSecond;
    this.inner.style.width = `${Math.ceil(2 * PAD + this.seconds * pps)}px`;
    const { major, minor } = rulerStep(pps);
    const frag = document.createDocumentFragment();
    for (let s = 0; s <= this.seconds + 1e-6; s += minor) {
      const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
      const tick = el(isMajor ? 'i.tl-tick.tl-major' : 'i.tl-tick');
      tick.style.left = `${PAD + s * pps}px`;
      frag.append(tick);
      if (isMajor) {
        const label = el('span.tl-label', null, timeText(s * TICK_RATE).replace(/\.0$/, ''));
        label.style.left = `${PAD + s * pps}px`;
        frag.append(label);
      }
    }
    this.ruler.replaceChildren(frag);
    for (const m of this.track.querySelectorAll<HTMLElement>('.tl-goal')) m.style.left = `${this.x(Number(m.dataset.tick))}px`;
    this.paintRange();
    this.paintHead();
  }

  setRange(range: { start: number; end: number } | null): void {
    this.range = range;
    this.paintRange();
  }

  private paintRange(): void {
    const r = this.range;
    this.region.classList.toggle('rp-hidden', r === null);
    if (r === null) return;
    this.region.style.left = `${this.x(r.start)}px`;
    this.region.style.width = `${Math.max(2, this.x(r.end) - this.x(r.start))}px`;
    this.regionLabel.textContent = `${((r.end - r.start) / TICK_RATE).toFixed(1)} s`;
  }

  /** Put the playhead at `tick`; while `follow` (playing) the view scrolls to keep it in sight. */
  setPlayhead(tick: number, follow = false): void {
    this.playTick = tick;
    this.paintHead();
    if (follow && this.drag === null) this.reveal(tick);
  }

  private paintHead(): void {
    this.head.style.left = `${this.x(this.playTick)}px`;
  }

  /** Scroll so `tick` is inside the view. */
  reveal(tick: number): void {
    const x = this.x(tick);
    const w = this.scroll.clientWidth;
    if (x < this.scroll.scrollLeft + 20 || x > this.scroll.scrollLeft + w - 20) this.scroll.scrollLeft = Math.max(0, x - w * 0.25);
  }

  setZoom(z: number): void {
    const centre = this.scroll.scrollLeft + this.scroll.clientWidth / 2;
    const before = this.pxPerSecond;
    this.zoomK = Math.min(MAX_ZOOM, Math.max(1, z));
    this.layout();
    this.scroll.scrollLeft = Math.max(0, (centre / before) * this.pxPerSecond - this.scroll.clientWidth / 2);
  }

  private zoomAt(f: number, clientX: number): void {
    const r = this.scroll.getBoundingClientRect();
    const px = clientX - r.left;
    const sec = (this.scroll.scrollLeft + px - PAD) / this.pxPerSecond;
    this.zoomK = Math.min(MAX_ZOOM, Math.max(1, this.zoomK * f));
    this.layout();
    this.scroll.scrollLeft = Math.max(0, PAD + sec * this.pxPerSecond - px);
  }

  fit(): void {
    this.zoomK = 1;
    this.layout();
    this.scroll.scrollLeft = 0;
  }

  /** Zoom to the range (with a margin) and scroll to it. */
  showRange(): void {
    const r = this.range;
    if (r === null) return;
    const span = Math.max(1, (r.end - r.start) / TICK_RATE) * 1.6;
    const fit = Math.max(1, (this.scroll.clientWidth - 2 * PAD) / this.seconds);
    this.zoomK = Math.min(MAX_ZOOM, Math.max(1, this.scroll.clientWidth / span / fit));
    this.layout();
    this.scroll.scrollLeft = Math.max(0, this.x(r.start) - this.scroll.clientWidth * 0.2);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const h = target.dataset.h;
    this.inner.setPointerCapture(e.pointerId);
    if (h === 'start' || h === 'end') {
      this.drag = { kind: h };
      e.preventDefault();
      return;
    }
    if (this.range !== null && target.closest('.tl-region') !== null) {
      this.drag = { kind: 'move', x0: e.clientX, start0: this.range.start, end0: this.range.end, moved: false };
      e.preventDefault();
      return;
    }
    this.drag = { kind: 'scrub' };
    this.o.onSeek(this.tickAt(e.clientX));
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (d === null || (this.range === null && d.kind !== 'scrub')) return;
    const tick = this.tickAt(e.clientX);
    if (d.kind === 'scrub') {
      this.o.onSeek(tick);
    } else if (d.kind === 'start' && this.range !== null) {
      this.o.onRange(clampClipRange(tick, this.range.end, this.o.endTick, 'start'), 'start');
    } else if (d.kind === 'end' && this.range !== null) {
      this.o.onRange(clampClipRange(this.range.start, tick, this.o.endTick, 'end'), 'end');
    } else if (d.kind === 'move') {
      const delta = ((e.clientX - d.x0) / this.pxPerSecond) * TICK_RATE;
      if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
      if (d.moved) this.o.onRange(moveClipRange(d.start0, d.end0, delta, this.o.endTick), 'move');
    }
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (this.inner.hasPointerCapture(e.pointerId)) this.inner.releasePointerCapture(e.pointerId);
    // a click on the range (no drag) moves the playhead there
    if (d !== null && d.kind === 'move' && !d.moved) this.o.onSeek(this.tickAt(e.clientX));
  }
}
