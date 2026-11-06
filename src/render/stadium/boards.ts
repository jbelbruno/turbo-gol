/**
 * The board band: the shell below BOARD_SPLIT_Y (and the flat goal-module panels round each goal
 * mouth), opaque and lit. Drawn from its surface coordinates (uv = distance round the outline,
 * profile distance up the wall; geometry.ts splitShell):
 *
 *  - the floor ramp's foot is a turf-coloured pad that darkens toward the boards (their shadow);
 *  - the LED boards (LED_LO..LED_HI, on the upper ramp and the foot of the wall, so they stay under
 *    y ~ 340 and the backdrop shows above them) are cards from the canvas atlas (textures.ts), one
 *    card per panel of PANEL_LEN uu (PANEL_COUNT round the outline); a card shows for 30 s, then
 *    the panel dims for about a second and comes back with the next one (a calm change that
 *    travels round the stadium, never a slide); dim (ledIntensity ~0.4), with dark seams between
 *    panels and, on tiers with `netDetail`, an LED dot grid that only shows up close;
 *  - in the middle of each side wall a big board, BIG_PANELS panels wide without seams inside it,
 *    alternates between the place's main and secondary sponsor (content.ts) every 30 s, half a
 *    period out of step with the other boards so the stadium never changes everything at once;
 *    its card is the atlas's wide layout cut in thirds, one third per panel (no extra texture or
 *    draw: the same band material and the same single texture read per pixel);
 *  - a thin white LED rail on top;
 *  - beside each goal mouth the band is a dark padded surround (no boards, no rail), so the goal
 *    frames read against it; above the band the goal module is netting like the rest of the wall.
 *
 * The texture is sampled with explicit gradients from a continuous coordinate, so there are no mip
 * seams at the panel and card edges. Bloom: the LEDs feed it softly (they are large), the rail more.
 */
import * as THREE from 'three/webgpu';
import { abs, dFdx, dFdy, float, floor, fract, fwidth, hash, length, max, min, mix, mod, normalWorld, oneMinus, positionWorld, smoothstep, step, texture, time, uv, vec2, vec3 } from 'three/tsl';
import { glowMrt } from '../materials';
import type { TierSpec } from '../quality';
import { BIG_FIRST, BIG_PANELS, FIELD, LED_FRAME, LED_HI, LED_LO, PANEL_COUNT, PANEL_LEN, RAIL_HI, RAIL_LO } from './layout';
import { stadiumLight, type StadiumUniforms } from './palette';
import { BIG_CELL0, BOARD_CARDS, BOARD_COLS, BOARD_ROWS } from './textures';

/**
 * Seconds per card (the owner: every half minute, so the boards never distract the player), the
 * travel of the change round the stadium (s per uu: ~10 s for a lap), the big board's period and
 * its offset from the others (half a period).
 */
export const CARD_SECONDS = 30;
const CARD_WAVE = 0.00028;
export const BIG_SECONDS = 30;
const BIG_PHASE = 15;
/** The big board's change: it dims to DIP_LEVEL over CHANGE_FADE s and comes back with the next card. */
const CHANGE_FADE = 0.55;
const DIP_LEVEL = 0.08;
/** A regular card's change (the first boards' "Mexican wave"): the new card slides down over the old in SLIDE_SECONDS. */
const SLIDE_SECONDS = 0.36;
/** Width (pixels) of the filter that antialiases the bands' edges. */
const EDGE_SOFT = 4;

export function buildBoardMaterial(spec: TierSpec, u: StadiumUniforms, atlas: THREE.Texture): THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial {
  const m = spec.bakedLight ? new THREE.MeshBasicNodeMaterial() : new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  const s = uv().x;
  const h = uv().y;
  const p = positionWorld;
  // The goal-module surround (the flat panel beside each mouth, below the netting): no boards there.
  const surround = step(abs(p.x), float(FIELD.moduleHalfW + 20)).mul(step(float(FIELD.halfZ - 200), abs(p.z)));
  const boardsOn = oneMinus(surround);

  // The bands (the board, its dark frame, the rail) are drawn by their coverage of the pixel: a box
  // filter of the band over EDGE_SOFT pixels of the profile distance, not a hard step. MSAA only
  // smooths geometry edges, not edges computed in the shader, so a band of a pixel or less (the rail
  // from across the pitch) used to show as dashes, on every tier.
  const fw = fwidth(h).mul(EDGE_SOFT).max(1e-4);
  const bandOf = (lo: number, hi: number): typeof h => min(h.add(fw.mul(0.5)), float(hi)).sub(max(h.sub(fw.mul(0.5)), float(lo))).div(fw).saturate();
  const inBand = bandOf(LED_LO, LED_HI);
  const inLed = bandOf(LED_LO + LED_FRAME, LED_HI - LED_FRAME).mul(boardsOn);
  const ly = h.sub(LED_LO + LED_FRAME).div(LED_HI - LED_LO - 2 * LED_FRAME).saturate();
  // Panel k spans s in [(k - 1/2), (k + 1/2)) PANEL_LEN (layout.ts panelAt); s >= 0, so mod is safe.
  const sp = s.div(PANEL_LEN).add(0.5);
  const panel = mod(floor(sp), PANEL_COUNT);
  const lx = fract(sp);
  // The big board: panels BIG_FIRST .. + BIG_PANELS - 1 on one side wall, the same half the
  // outline later on the other (d = the panel within it, 0 .. BIG_PANELS - 1).
  const d = mod(panel.add(PANEL_COUNT - BIG_FIRST), PANEL_COUNT / 2);
  const big = step(d, BIG_PANELS - 0.5);
  // Regular cards change every CARD_SECONDS as a wave round the stadium (the first boards' "Mexican
  // wave"): the change travels along the outline (CARD_WAVE s per uu, through the panels, not panel
  // by panel) and at each point the new card slides down over the old one. The big board changes
  // every BIG_SECONDS, all of it at once with a short dip, half a period after the others.
  const tt = time.add(s.mul(CARD_WAVE)).div(CARD_SECONDS);
  const slot = floor(tt);
  const slide = smoothstep(0, SLIDE_SECONDS, fract(tt).mul(CARD_SECONDS));
  const group = mod(panel, 4);
  const cardOf = (sl: typeof slot): typeof slot => floor(hash(sl.mul(3.17).add(group.mul(11.3)).add(1.7)).mul(BOARD_CARDS - 0.001));
  const useNew = step(oneMinus(slide), ly);
  const card = mix(cardOf(slot.sub(1)), cardOf(slot), useNew);
  const cardY = mix(ly.add(slide), ly.sub(oneMinus(slide)), useNew).saturate();
  const tb = time.add(BIG_PHASE).div(BIG_SECONDS);
  const bigCell = mod(floor(tb), 2).mul(BIG_PANELS).add(d).add(BIG_CELL0);
  const cell = mix(card, bigCell, big);
  const fb = fract(tb).mul(BIG_SECONDS);
  const dip = smoothstep(0, CHANGE_FADE, fb).mul(oneMinus(smoothstep(float(BIG_SECONDS - CHANGE_FADE), float(BIG_SECONDS), fb)));
  const level = mix(float(1), mix(float(DIP_LEVEL), float(1), dip), big);
  const cy = mix(cardY, ly, big);
  const col = mod(cell, BOARD_COLS);
  const row = floor(cell.div(BOARD_COLS));
  // A card keeps a 1 px border in its cell; a third of a big card fills its cell, read up to half
  // a texel (and a bit) from the edges so the thirds join without a line (textures.ts drawBoards).
  const edge = 0.75 / ((atlas.image as { width: number }).width / BOARD_COLS);
  const cx = mix(lx.mul(0.996).add(0.002), lx.clamp(edge, 1 - edge), big);
  const auv = vec2(
    col.add(cx).div(BOARD_COLS),
    float(1).sub(row.add(1).div(BOARD_ROWS)).add(cy.mul(0.98).add(0.01).div(BOARD_ROWS)),
  ).saturate();
  const cont = vec2(s.div(PANEL_LEN * BOARD_COLS), h.div((LED_HI - LED_LO - 2 * LED_FRAME) * BOARD_ROWS));
  const tex = texture(atlas, auv).grad(dFdx(cont), dFdy(cont)).rgb;

  let led = tex;
  if (spec.netDetail) {
    // LED dot grid (pitch 6 uu), only up close; it fades out before it could alias.
    const PITCH = 6;
    const fpx = max(fwidth(s), fwidth(h));
    const dot = fract(vec2(s, h).div(PITCH)).sub(0.5);
    const dots = oneMinus(smoothstep(0.28, 0.5, length(dot)));
    const near = oneMinus(smoothstep(PITCH * 0.25, PITCH * 0.7, fpx));
    led = tex.mul(mix(float(1), dots.mul(1.5).add(0.15), near));
  }
  // Dark seams between panels, none inside the big board (only at its two ends).
  const seamL = max(smoothstep(0, 0.004, lx), big.mul(step(0.5, d)));
  const seamR = max(oneMinus(smoothstep(0.996, 1, lx)), big.mul(step(d, BIG_PANELS - 1.5)));
  const gap = seamL.mul(seamR);
  const ledOn = led.mul(inLed).mul(gap).mul(level).mul(u.ledIntensity);
  const rail = bandOf(RAIL_LO, RAIL_HI).mul(boardsOn);
  const railCol = vec3(0.85, 0.92, 1.0).mul(rail).mul(u.railIntensity);

  // The ramp pad under the boards: turf-coloured, darkening toward them. The frames and the cap
  // above the rail are near-black; the surround is a dark padded panel with faint vertical seams.
  const pad = u.rampColor.mul(mix(float(1), float(0.35), smoothstep(float(-180), float(LED_LO), h)));
  const frameCol = vec3(0.012, 0.013, 0.017);
  const seams = smoothstep(0.0, 0.02, fract(p.x.div(290))).mul(0.25).add(0.75);
  const surroundCol = vec3(0.022, 0.024, 0.03).mul(seams);
  const base = mix(pad, frameCol, max(inBand, bandOf(LED_HI, 1e5)).mul(boardsOn));
  const albedo = mix(mix(base, vec3(0, 0, 0), inLed), surroundCol, surround.mul(step(float(LED_LO), h)));
  if (m instanceof THREE.MeshStandardNodeMaterial) {
    m.colorNode = albedo;
    // The LED face: a satin finish (a glossier one mirrored the lamp heads as a bright streak
    // across the sponsors' names).
    m.roughnessNode = mix(float(0.7), float(0.5), inLed);
    m.emissiveNode = ledOn.add(railCol);
  } else {
    // bakedLight: unlit, the theme's baked light on the pad and the frames, the LEDs self-lit.
    m.colorNode = albedo.mul(stadiumLight(u, normalWorld)).add(ledOn).add(railCol);
  }
  m.mrtNode = glowMrt(ledOn.mul(0.15).add(railCol.mul(0.5)), 'none');
  return m;
}
