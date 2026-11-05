/**
 * The players' names over their cars (the owner's "Neón de arena", 2026-11-05), in every match the
 * Game draws (VS AI, Casual and Competitive on the servers, P2P rooms; 1v1 to 3v3) and in the
 * replay viewer, so a player always knows where every rival and teammate is. No plate: the name in
 * the display face's italic capitals, lit in its team's neon over a soft dark halo, a thin skewed
 * line under it and a post on its team's goal side (blue left, red right). Under a TEAMMATE's name
 * (the viewer's team, not blue) a lime meter shows the boost it has left; a rival never gets one. A
 * replay has no viewer team: there every car shows its meter.
 *
 *   distance    three steps by the camera's distance (TAG_MID_AT, TAG_FAR_AT, with TAG_HYSTERESIS
 *               either way, so a car on the line does not flicker): smaller, a shorter glow, dimmer
 *               (TAG_OPACITY); never under 12 px (tokens.css --t-tag*), 1.25x on a TV
 *   bots        a robot before the name and a dimmer glow
 *   the ball    a tag over the ball's circle on screen fades to TAG_OVER_BALL_OPACITY: it never hides it
 *   off screen  off any edge or behind the camera: pinned inside the safe inset at the left or
 *               right edge, ‹‹ or ›› towards the car (behind the camera the direction is mirrored),
 *               at full opacity; back over its car only TAG_EDGE_BAND inside the picture, so a car
 *               along an edge does not flip it every frame
 *   crowds      no tag covers another (TAG_GAP apart), nearer cars first (an order that changes only
 *               past TAG_ORDER_HYSTERESIS, so two tags do not trade places every frame): on screen a
 *               farther car's tag goes up over the nearer one's, never down over the nearer car but
 *               with no room up; an edge tag goes along its edge the nearer way (the way it went
 *               before unless the other is a tag's height nearer); all inside the safe inset. No
 *               jumping up and down as cars side by side wobble: a tag moved off another stays moved
 *               until TAG_STACK_HOLD clear of it, and one the safe rect's top or bottom sent the
 *               other way comes back only with a tag's height of room
 *   no tag      the viewer's own car (in a replay, the car the camera follows), a demolished car
 *               until it respawns, a point inside the camera's near plane
 *   the player  Settings > HUD, read each frame through the Game's getter (src/render/hudView.ts):
 *               names over every other car, the rivals', the teammates' or none, and a teammate's
 *               meter on or off; a rival's meter never. The replay viewer passes none: every tag
 *               and every meter, as before
 *
 * The model is pure (tagBucket, tagAnchor, clampTag, orderTags, declutterTags, overBall, tagClass...:
 * tests/name-tags.test.mjs).
 * NameTags is the thin DOM layer, one element per car in a layer under the HUD (pointer-events
 * none): per frame it writes a transform and an opacity, each only when it changed; a class when
 * the step or the state changes; the boost when its whole number changes. A tag is measured again
 * only after such a change (all of them in one read pass: one layout), the layer on a resize or
 * when its safe rect moves (a page's own bars: nametags.css --tags-inset-*); the declutter pass
 * works on those cached boxes alone. Names go in as text, never as markup. Styling:
 * src/ui/styles/nametags.css.
 */
import * as THREE from 'three/webgpu';
import type { HudSettings } from '../settings';
import { BALL } from '../sim/constants';
import { C_BOOST, C_IS_DEMOED } from '../sim/types';
import { boostBarShown, tagShown as tagInView } from './hudView';

/** A tag floats this far above its car's origin (uu). */
export const TAG_HEIGHT = 140;
/** Camera distances (uu) where a tag steps to the middle and to the far look... */
export const TAG_MID_AT = 2500;
export const TAG_FAR_AT = 5000;
/** ...and the band either side of each that keeps the step it had. */
export const TAG_HYSTERESIS = 250;
/** Opacity of each step (base, mid, far; a tag pinned to an edge has the base's) and of one over the ball. */
export const TAG_OPACITY: readonly [number, number, number] = [1, 0.86, 0.72];
export const TAG_OVER_BALL_OPACITY = 0.35;
/** A tag pinned to an edge comes back over its car only this far (NDC) inside the picture. */
export const TAG_EDGE_BAND = 0.04;
/** Off the picture, a car within this share of the edge of straight above, below or behind keeps its arrow's side. */
export const TAG_SIDE_DEADBAND = 0.15;
/** The room (CSS px) the declutter pass leaves between two tags. */
export const TAG_GAP = 2;
/** A tag the pass moved off another goes back only this much (CSS px) past TAG_GAP clear of it: cars side by side do not make it jump up and down. */
export const TAG_STACK_HOLD = 8;
/** A car's tag passes another's in the declutter order only when nearer by more than this (uu): cars side by side keep their places. */
export const TAG_ORDER_HYSTERESIS = 250;
/** The safe inset (CSS px) when the layer's own (the safe area plus 12 px: nametags.css) cannot be measured. */
const TAG_INSET = 12;

/** The distance step: 0 base, 1 mid, 2 far. */
export type TagBucket = 0 | 1 | 2;
/** 0 on screen; 1 pinned to the right edge (››), -1 to the left one (‹‹). */
export type TagSide = -1 | 0 | 1;
/** Which way the declutter pass moved a tag: -1 up, 1 down (along an edge, or on screen with no room up), 0 not at all. */
export type TagStack = -1 | 0 | 1;

/** A car as the roster has it (Hud.ts ScoreboardRow fits): `bot` defaults to true for every car but the player's own. */
export interface TagRow {
  readonly name: string;
  readonly team: 0 | 1;
  readonly you?: boolean;
  readonly bot?: boolean;
}

/** A tag's size (CSS px) and how far its arrow reaches past its left or right side. */
export interface TagBox {
  w: number;
  h: number;
  ovl: number;
  ovr: number;
}

/** The part of the layer a tag stays inside (CSS px). */
export interface SafeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A tag as the declutter pass sees it: its top left corner (CSS px, clampTag's; the pass moves
 * `top`), its box and side; `id`, its car's slot (under 31: a bit of `held`); what the pass did the
 * frame before: the way it moved it and the tags it moved it off (`held`, a bit per `id`).
 */
export interface TagPlace {
  readonly id: number;
  left: number;
  top: number;
  readonly box: TagBox;
  side: TagSide;
  stack: TagStack;
  held: number;
}

/** The distance step for a camera distance `dist` (uu), from the step the tag had. */
export function tagBucket(dist: number, prev: TagBucket): TagBucket {
  const h = TAG_HYSTERESIS;
  let b = prev;
  if (b === 0 && dist > TAG_MID_AT + h) b = 1;
  if (b === 1 && dist > TAG_FAR_AT + h) b = 2;
  if (b === 2 && dist < TAG_FAR_AT - h) b = 1;
  if (b === 1 && dist < TAG_MID_AT - h) b = 0;
  return b;
}

/** Car `i` has a tag: not the viewer's own (`self`, -1 none) and not demolished. */
export function tagShown(i: number, self: number, demoed: boolean): boolean {
  return i !== self && !demoed;
}

/** A teammate's tag carries the boost meter (while the player keeps it: hudView.ts boostBarShown), a rival's never; with no viewer team (a replay's spectator) every car's does. */
export function tagHasMeter(team: 0 | 1, viewerTeam: 0 | 1 | null): boolean {
  return viewerTeam === null || team === viewerTeam;
}

/** The row is a bot's: neither the player's own nor a human's. */
export function isBotRow(r: TagRow): boolean {
  return r.you !== true && r.bot !== false;
}

/** The meter's whole number from the state's 0..100 boost. */
export function boostPct(v: number): number {
  return v > 0 ? Math.min(100, Math.round(v)) : 0;
}

/**
 * Where a tag hangs from (CSS px of a `w` x `h` layer) for its point projected to NDC (`nx`, `ny`,
 * `nz`: Vector3.project). On screen: right over the point. Off any edge or behind the camera
 * (nz > 1: the projection went through the eye, so x and y are mirrored back): at the left or right
 * edge, where the way from the screen's centre to the car crosses the picture's border (a car off
 * the top or the bottom: that edge's corner), `out.side` saying which; straight behind it goes to
 * the bottom, and near straight above, below or behind the side stays `prevSide`'s. A tag pinned
 * before (`prevSide` not 0) comes back on screen only TAG_EDGE_BAND inside the edge. False inside
 * the near plane (nz < -1): no tag.
 */
export function tagAnchor(nx: number, ny: number, nz: number, prevSide: TagSide, w: number, h: number, out: { x: number; y: number; side: TagSide }): boolean {
  if (nz < -1) return false;
  if (nz > 1) {
    nx = -nx;
    ny = -ny;
  } else {
    const lim = prevSide !== 0 ? 1 - TAG_EDGE_BAND : 1;
    if (Math.abs(nx) <= lim && Math.abs(ny) <= lim) {
      out.side = 0;
      out.x = (nx + 1) * 0.5 * w;
      out.y = (1 - ny) * 0.5 * h;
      return true;
    }
  }
  let k = Math.max(Math.abs(nx), Math.abs(ny));
  if (k < 1e-6) {
    nx = 0;
    ny = -1;
    k = 1;
  }
  let side: TagSide = nx >= 0 ? 1 : -1;
  if (prevSide !== 0 && Math.abs(nx) < TAG_SIDE_DEADBAND * k) side = prevSide;
  out.side = side;
  out.x = side > 0 ? w : 0;
  out.y = (1 - ny / k) * 0.5 * h;
  return true;
}

/**
 * The top left corner (CSS px) of a tag hung from (`ax`, `ay`) by its bottom centre, kept inside
 * `safe` with its arrow (an edge's tag: its anchor is on the edge, so it sits against it).
 */
export function clampTag(ax: number, ay: number, box: TagBox, safe: SafeRect, out: { x: number; y: number }): void {
  const minX = safe.left + box.ovl;
  const maxX = safe.right - box.w - box.ovr;
  const x = ax - box.w * 0.5;
  out.x = maxX < minX ? minX : x < minX ? minX : x > maxX ? maxX : x;
  const maxY = safe.bottom - box.h;
  const y = ay - box.h;
  out.y = maxY < safe.top ? safe.top : y < safe.top ? safe.top : y > maxY ? maxY : y;
}

/**
 * Puts `order[0..n)` nearer car first by `dist` (uu), from the order it had: one passes the one
 * before it only when nearer by more than TAG_ORDER_HYSTERESIS, so a near tie keeps last frame's
 * order (an insertion sort: nothing to do on a frame where nothing passed).
 */
export function orderTags<T extends { readonly dist: number }>(order: T[], n: number): void {
  for (let i = 1; i < n; i++) {
    const t = order[i];
    let j = i;
    while (j > 0 && t.dist < order[j - 1].dist - TAG_ORDER_HYSTERESIS) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = t;
  }
}

/** A hair under TAG_GAP: a tag the pass put right against another does not hit it again on a rounding. */
const GAP_IN = TAG_GAP - 1e-6;

/**
 * Tag `a` with its top at `top` comes nearer `b` than TAG_GAP (their boxes, with an edge tag's
 * arrow). From a tag it was moved off the frame before (`a.held`) it keeps TAG_STACK_HOLD more room
 * across, and on the side it left `b` by going `dir`: under it going up (-1), over it going down.
 * So it goes back only once clearly apart, and a step that clears `b` (landing on its other side)
 * never hits it again.
 */
function crowds(a: TagPlace, top: number, b: TagPlace, dir: -1 | 1): boolean {
  let g = GAP_IN;
  let under = GAP_IN;
  let over = GAP_IN;
  if ((a.held >> b.id) & 1) {
    g += TAG_STACK_HOLD;
    if (dir < 0) under += TAG_STACK_HOLD;
    else over += TAG_STACK_HOLD;
  }
  return (
    a.left - a.box.ovl < b.left + b.box.w + b.box.ovr + g &&
    b.left - b.box.ovl < a.left + a.box.w + a.box.ovr + g &&
    top < b.top + b.box.h + under &&
    b.top < top + a.box.h + over
  );
}

/** The tags (a bit per id) the last freeTop moved its tag off. */
let _hits = 0;

/** The nearest top from `top` going `dir` (-1 up, 1 down) where `t` clears `placed[0..k)`, the ones it moved off in `_hits`; NaN once it would leave `safe`. */
function freeTop(t: TagPlace, top: number, dir: -1 | 1, placed: readonly TagPlace[], k: number, safe: SafeRect): number {
  const maxY = safe.bottom - t.box.h;
  _hits = 0;
  // Each step clears one tag for good (the way never turns back): k + 1 looks at most.
  for (let step = 0; step <= k; step++) {
    if (top < safe.top || top > maxY) return NaN;
    let hit: TagPlace | null = null;
    for (let j = 0; j < k && hit === null; j++) if (crowds(t, top, placed[j], dir)) hit = placed[j];
    if (hit === null) return top;
    _hits |= 1 << hit.id;
    top = dir < 0 ? hit.top - TAG_GAP - t.box.h : hit.top + hit.box.h + TAG_GAP;
  }
  return NaN;
}

/**
 * Moves `places[0..n)` (orderTags' order) off each other, TAG_GAP apart and inside `safe`: each
 * stays where it hangs unless it crowds one before it (off the tags it was moved off the frame
 * before, by TAG_STACK_HOLD more: crowds). Then a tag on screen goes up, over the nearer car's tag
 * (down only with no room up to the safe top); an edge tag goes along its edge the nearer way, or
 * the way it went the frame before unless the other is its own height nearer (no flip on a tie).
 * One sent down by the safe top (or up by the bottom) the frame before goes back only with its own
 * height of room there. With no room either way it stays. Only `top`, `stack` and `held` change;
 * no allocation.
 */
export function declutterTags(places: readonly TagPlace[], n: number, safe: SafeRect): void {
  for (let i = 0; i < n; i++) {
    const t = places[i];
    const from = t.top;
    // Looked at from the way it went the frame before (the hold's side).
    const was = t.stack > 0 ? 1 : -1;
    let crowded = false;
    for (let j = 0; j < i && !crowded; j++) crowded = crowds(t, from, places[j], was);
    if (!crowded) {
      t.stack = 0;
      t.held = 0;
      continue;
    }
    const hold = t.box.h;
    const up = freeTop(t, from, -1, places, i, safe);
    const upHits = _hits;
    // On screen it looks down only with no room up, or, gone down the frame before, with less than its height of room up.
    const down = t.side !== 0 || Number.isNaN(up) || (t.stack > 0 && up - safe.top < hold) ? freeTop(t, from, 1, places, i, safe) : NaN;
    let dir: TagStack = 0;
    if (!Number.isNaN(up) && !Number.isNaN(down)) {
      // Room both ways: the way it went before while the other has less than its height of room in `safe` (on
      // screen, why it looked down); else an edge tag's nearer way, the way it went before ahead by its height.
      if (t.stack > 0 && up - safe.top < hold) dir = 1;
      else if (t.stack < 0 && safe.bottom - hold - down < hold) dir = -1;
      else dir = down - from - (t.stack > 0 ? hold : 0) < from - up - (t.stack < 0 ? hold : 0) ? 1 : -1;
    } else if (!Number.isNaN(up)) dir = -1;
    else if (!Number.isNaN(down)) dir = 1;
    t.stack = dir;
    t.held = dir < 0 ? upHits : dir > 0 ? _hits : 0;
    if (dir !== 0) t.top = dir < 0 ? up : down;
  }
}

/** The `w` x `h` box at (`x`, `y`) overlaps the circle of radius `r` round (`cx`, `cy`). */
export function overBall(x: number, y: number, w: number, h: number, cx: number, cy: number, r: number): boolean {
  const dx = cx - Math.max(x, Math.min(cx, x + w));
  const dy = cy - Math.max(y, Math.min(cy, y + h));
  return dx * dx + dy * dy < r * r;
}

/** A tag's opacity: its step's (an edge tag has none: the base's), or faded over the ball. */
export function tagOpacity(bucket: TagBucket, side: TagSide, onBall: boolean): number {
  if (onBall) return TAG_OVER_BALL_OPACITY;
  return TAG_OPACITY[side !== 0 ? 0 : bucket];
}

/** What tagClass depends on, as one number (the class is rebuilt only when it changes). An edge tag has no step. */
export function tagKey(team: 0 | 1, meter: boolean, bot: boolean, bucket: TagBucket, side: TagSide): number {
  return team | (meter ? 2 : 0) | (bot ? 4 : 0) | ((side !== 0 ? 0 : bucket) << 3) | ((side + 1) << 5);
}

/** The tag's classes (nametags.css): its team, the meter, a bot, the step or the edge with the arrow's side. */
export function tagClass(team: 0 | 1, meter: boolean, bot: boolean, bucket: TagBucket, side: TagSide): string {
  let c = team === 1 ? 'tg-neon tg-neon--red' : 'tg-neon tg-neon--blue';
  if (meter) c += ' tg-neon--meter';
  if (bot) c += ' tg-neon--isbot';
  if (side !== 0) c += side > 0 ? ' tg-neon--off tg-neon--offr' : ' tg-neon--off tg-neon--offl';
  else if (bucket === 1) c += ' tg-neon--mid';
  else if (bucket === 2) c += ' tg-neon--far';
  return c;
}

/** One car's tag and what is on it now (-1, '' or NaN: nothing written yet); `left`, `top`: this frame's place. */
interface Tag extends TagPlace {
  readonly el: HTMLElement;
  readonly text: HTMLElement;
  readonly fill: HTMLElement;
  readonly arrow: HTMLElement;
  key: number;
  name: string;
  boost: number;
  opacity: number;
  x: number;
  y: number;
  shown: boolean;
  bucket: TagBucket;
  /** Its box is to be measured again (a class or the name changed, or it came back). */
  dirty: boolean;
  /** This frame's anchor (CSS px). */
  ax: number;
  ay: number;
  /** This frame's camera distance (uu; Infinity while it has no tag: last in orderTags' order). */
  dist: number;
}

const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _anchor: { x: number; y: number; side: TagSide } = { x: 0, y: 0, side: 0 };
const _at = { x: 0, y: 0 };

/** What the player chose to see of the tags (Settings > HUD: settings.hud). */
export type TagView = Readonly<Pick<HudSettings, 'names' | 'teamBoost'>>;

/** No view (the replay viewer): every tag, every meter. */
const ALL_TAGS: TagView = { names: 'all', teamBoost: true };

/**
 * The DOM layer: `root` covers the picture (the Game's under the HUD, the replay's #tags); hidden
 * until setVisible(true). `view`, read on every update: the player's choice (the Game's live settings).
 */
export class NameTags {
  private readonly root: HTMLElement;
  private readonly view: () => TagView;
  /** An empty box at the safe inset (nametags.css .tg-tags-safe): the safe rect, measured with the layer. */
  private readonly probe: HTMLElement;
  private readonly tags: Tag[] = [];
  /** The tags nearer car first (orderTags, kept from frame to frame), and this frame's shown ones in that order. */
  private readonly order: Tag[] = [];
  private readonly vis: Tag[] = [];
  private on = false;
  /** The layer's size and safe rect are current (a resize, the probe's, the fonts or showing it again clear it). */
  private sized = false;
  private w = 0;
  private h = 0;
  private readonly safe: SafeRect = { left: 0, top: 0, right: 0, bottom: 0 };

  constructor(root: HTMLElement, view: () => TagView = () => ALL_TAGS) {
    this.root = root;
    this.view = view;
    root.classList.add('tg-tags');
    // The scoreboard says who is who; the tags only show where.
    root.setAttribute('aria-hidden', 'true');
    root.hidden = true;
    this.probe = el('div', 'tg-tags-safe');
    root.append(this.probe);
    const again = (): void => {
      this.sized = false;
      for (const t of this.tags) t.dirty = true;
    };
    window.addEventListener('resize', again);
    // The display face swapping in changes every tag's width.
    document.fonts?.addEventListener('loadingdone', again);
    // A page's own bars moving the safe rect with no resize (the replay viewer's: nametags.css --tags-inset-*).
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        this.sized = false;
      }).observe(this.probe);
    }
  }

  /** Show or hide the whole layer (cached: nothing is written when it does not change). */
  setVisible(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.root.hidden = !on;
    if (on) {
      this.sized = false;
      for (const t of this.tags) t.dirty = true;
    }
  }

  /**
   * Place every tag for the frame drawn with `camera`: car `i` is `rows[i]` (its name, team, bot),
   * drawn at `cars[i].position` (the rendered, interpolated one), its state at `state[offsets[i]]`.
   * `self` has no tag (-1 none); `viewerTeam` picks the teammates (null: every car shows its boost).
   * `ball`: the ball's drawn position. Allocation-free but for the style strings it writes.
   */
  update(
    camera: THREE.PerspectiveCamera,
    rows: readonly TagRow[],
    cars: readonly { readonly position: THREE.Vector3 }[],
    offsets: readonly number[],
    state: Float32Array,
    ball: THREE.Vector3,
    self: number,
    viewerTeam: 0 | 1 | null,
  ): void {
    if (!this.on) return;
    const n = Math.min(rows.length, cars.length, offsets.length);
    if (n !== this.tags.length) this.build(n);
    if (!this.sized) this.measureLayer();
    const w = this.w;
    const h = this.h;
    if (w <= 0 || h <= 0) return;
    camera.updateMatrixWorld();
    _eye.setFromMatrixPosition(camera.matrixWorld);
    const tags = this.tags;
    const view = this.view();

    // What each tag shows this frame: its step and side, its classes, its name and its boost.
    for (let i = 0; i < n; i++) {
      const t = tags[i];
      const row = rows[i];
      const off = offsets[i];
      // A teammate by the viewer's team (a replay's spectator: every car), for the player's choice and the meter.
      const mate = tagHasMeter(row.team, viewerTeam);
      let shown = tagShown(i, self, state[off + C_IS_DEMOED] > 0.5) && tagInView(view.names, mate);
      if (shown) {
        const p = cars[i].position;
        _v.set(p.x, p.y + TAG_HEIGHT, p.z);
        const dist = _v.distanceTo(_eye);
        _v.project(camera);
        shown = tagAnchor(_v.x, _v.y, _v.z, t.side, w, h, _anchor);
        if (shown) {
          t.ax = _anchor.x;
          t.ay = _anchor.y;
          t.bucket = tagBucket(dist, t.bucket);
          t.dist = dist;
        }
      }
      if (shown !== t.shown) {
        t.shown = shown;
        t.el.hidden = !shown;
        if (shown) t.dirty = true;
      }
      if (!shown) {
        t.dist = Infinity;
        t.stack = 0;
        t.held = 0;
        continue;
      }
      if (row.name !== t.name) {
        t.name = row.name;
        t.text.textContent = row.name;
        t.dirty = true;
      }
      const side = _anchor.side;
      const meter = boostBarShown(view.names, view.teamBoost, mate);
      const bot = isBotRow(row);
      const key = tagKey(row.team, meter, bot, t.bucket, side);
      if (key !== t.key) {
        t.key = key;
        t.el.className = tagClass(row.team, meter, bot, t.bucket, side);
        if (side !== t.side) t.arrow.textContent = side > 0 ? '››' : side < 0 ? '‹‹' : '';
        t.dirty = true;
      }
      t.side = side;
      if (meter) {
        const b = boostPct(state[off + C_BOOST]);
        if (b !== t.boost) {
          t.boost = b;
          t.fill.style.transform = `scaleX(${b / 100})`;
        }
      }
    }

    // The boxes that changed, read together: one layout for all of them, none on a quiet frame.
    for (let i = 0; i < n; i++) {
      const t = tags[i];
      if (!t.shown || !t.dirty) continue;
      t.dirty = false;
      const b = t.box;
      b.w = t.el.offsetWidth;
      b.h = t.el.offsetHeight;
      const a = t.arrow;
      b.ovl = t.side < 0 ? Math.max(0, -a.offsetLeft) : 0;
      b.ovr = t.side > 0 ? Math.max(0, a.offsetLeft + a.offsetWidth - b.w) : 0;
    }

    // Each tag where it hangs (on the half pixel), nearer cars first, then off each other's boxes.
    const order = this.order;
    orderTags(order, n);
    const vis = this.vis;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = order[i];
      if (!t.shown) continue;
      clampTag(t.ax, t.ay, t.box, this.safe, _at);
      t.left = Math.round(_at.x * 2) / 2;
      t.top = Math.round(_at.y * 2) / 2;
      vis[k++] = t;
    }
    declutterTags(vis, k, this.safe);

    // The ball's circle on screen (none behind the camera), then each tag's place and opacity.
    let bx = 0;
    let by = 0;
    let br = 0;
    _v.copy(ball).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_v.z;
    if (depth > camera.near) {
      br = ((BALL.radius * camera.projectionMatrix.elements[5]) / depth) * h * 0.5;
      _v.applyMatrix4(camera.projectionMatrix);
      bx = (_v.x + 1) * 0.5 * w;
      by = (1 - _v.y) * 0.5 * h;
    }
    for (let i = 0; i < k; i++) {
      const t = vis[i];
      const x = t.left;
      const y = t.top;
      if (x !== t.x || y !== t.y) {
        t.x = x;
        t.y = y;
        t.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      const o = tagOpacity(t.bucket, t.side, br > 0 && overBall(x, y, t.box.w, t.box.h, bx, by, br));
      if (o !== t.opacity) {
        t.opacity = o;
        t.el.style.opacity = String(o);
      }
    }
  }

  /** One tag per car, built again when the roster's size changes (a roster of the same size is diffed by update). */
  private build(n: number): void {
    for (const t of this.tags) t.el.remove();
    this.tags.length = 0;
    for (let i = 0; i < n; i++) {
      const tag = el('div', 'tg-neon');
      const name = el('div', 'tg-neon-name');
      const text = el('span', '');
      name.append(el('span', 'tg-neon-bot'), text);
      const boost = el('div', 'tg-neon-boost');
      const fill = el('div', 'tg-neon-boost-fill');
      boost.append(fill);
      const arrow = el('span', 'tg-neon-arrow');
      tag.append(name, el('div', 'tg-neon-line'), el('div', 'tg-neon-post'), boost, arrow);
      tag.hidden = true;
      this.root.append(tag);
      this.tags.push({ id: i, el: tag, text, fill, arrow, key: -1, name: '', boost: -1, opacity: -1, x: NaN, y: NaN, shown: false, bucket: 0, side: 0, dirty: true, box: { w: 0, h: 0, ovl: 0, ovr: 0 }, ax: 0, ay: 0, left: 0, top: 0, stack: 0, held: 0, dist: Infinity });
    }
    // The first order is the slots' (a tie keeps it).
    this.order.length = 0;
    this.order.push(...this.tags);
    this.vis.length = 0;
    this.vis.push(...this.tags);
  }

  /** The layer's size and its safe rect (the probe's box; the bare inset if it has none). */
  private measureLayer(): void {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    this.w = w;
    this.h = h;
    this.sized = w > 0 && h > 0;
    const p = this.probe;
    const s = this.safe;
    if (p.offsetWidth > 0 && p.offsetHeight > 0) {
      s.left = p.offsetLeft;
      s.top = p.offsetTop;
      s.right = p.offsetLeft + p.offsetWidth;
      s.bottom = p.offsetTop + p.offsetHeight;
    } else {
      s.left = TAG_INSET;
      s.top = TAG_INSET;
      s.right = w - TAG_INSET;
      s.bottom = h - TAG_INSET;
    }
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
