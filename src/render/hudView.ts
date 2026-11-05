/**
 * What each player chose to see during a match (Settings > HUD, `settings.hud`; the owner's "que sea
 * configurable desde el menú, qué quiero ver", 2026-11-05), pure:
 *
 *   classes     the ones Hud.setView puts on the HUD's root (style.css): a `hud-no-*` hides its part
 *               (the scorebug keeps its box, the touch tap target of the full scoreboard), `hud-sr-goal`
 *               leaves the goal banner to a screen reader, a `hud-show-*` shows a readout F3 shows too
 *   the feed    which chips get through: the players' (joined, left, a bot takes over) and DEMOLISHED
 *   name tags   whose cars carry one, and which carry the boost meter (src/render/nameTags.ts)
 *   Ajustes     which rows it lists: the teammates' boost only while the names include them, the
 *               signal bars only while the scorebug they sit in shows, none that does nothing in
 *               touch mode (its own buttons show the boost and the camera)
 *
 * The rest is the Game's, read from the same settings: the ball's arrow at the edge and its ring on
 * the floor (Ball.setGroundMarker), the controls card and the click-for-mouse hint.
 *
 * A rival never gets a boost meter, whatever the setting (boostBarShown): each player sees only
 * what their own team could tell them. Nothing here reaches the match, only this player's screen.
 * The replay viewer never calls Hud.setView (today's look) and gives its tags no view: every car
 * keeps its tag and its meter there. No DOM: tests/hud-view.test.mjs.
 */
import type { HudSettings, NameTagMode } from '../settings';

/** Every class Hud.setView may put on the HUD's root: it takes off the ones hudClasses leaves out. */
export const HUD_VIEW_CLASSES = ['hud-no-score', 'hud-no-boost', 'hud-no-cam', 'hud-no-bars', 'hud-no-controls', 'hud-sr-goal', 'hud-show-fps', 'hud-show-speed'] as const;

export type HudViewClass = (typeof HUD_VIEW_CLASSES)[number];

/** The root's classes for `h` (allocates: on a settings change only). */
export function hudClasses(h: Readonly<HudSettings>): HudViewClass[] {
  const out: HudViewClass[] = [];
  if (!h.scorebug) out.push('hud-no-score');
  if (!h.boost) out.push('hud-no-boost');
  if (!h.camera) out.push('hud-no-cam');
  if (!h.netBars) out.push('hud-no-bars');
  // The training panel's key hints (the card and the hint are the Game's).
  if (!h.controls) out.push('hud-no-controls');
  if (!h.goal) out.push('hud-sr-goal');
  if (h.fps) out.push('hud-show-fps');
  if (h.speed) out.push('hud-show-speed');
  return out;
}

/** A chip of the feed (Hud.feed): who joined, who left, a bot taking a seat over, your demolitions. */
export type FeedKind = 'join' | 'leave' | 'bot' | 'demo';

/** A chip of `kind` gets through: DEMOLISHED with `demos`, the players' with `players`. */
export function feedShown(h: Readonly<Pick<HudSettings, 'players' | 'demos'>>, kind: FeedKind): boolean {
  return kind === 'demo' ? h.demos : h.players;
}

/** A car has a tag by `mode`: a teammate's (`isTeammate`) or a rival's. */
export function tagShown(mode: NameTagMode, isTeammate: boolean): boolean {
  switch (mode) {
    case 'all':
      return true;
    case 'rivals':
      return !isTeammate;
    case 'team':
      return isTeammate;
    default:
      return false;
  }
}

/** The boost meter under a tag: a teammate's, while its tag shows and `teamBoost` is on; a rival's never. */
export function boostBarShown(mode: NameTagMode, teamBoost: boolean, isTeammate: boolean): boolean {
  return isTeammate && teamBoost && tagShown(mode, true);
}

/** The teammates' boost row is listed while the names include the teammates. */
export function teamBoostOffered(mode: NameTagMode): boolean {
  return tagShown(mode, true);
}

/** The signal bars' row is listed while the scorebug shows: they sit in it, and hud-no-score hides them along. */
export function netBarsOffered(scorebug: boolean): boolean {
  return scorebug;
}

/** The rows that do nothing in touch mode: BOOST shows the amount, CAM the camera, and no controls card shows there. */
export const HUD_TOUCH_HIDDEN: readonly (keyof HudSettings)[] = ['boost', 'camera', 'controls'];

/** Ajustes lists the row of `key` (touch mode: not the ones HUD_TOUCH_HIDDEN names). */
export function hudRowShown(key: keyof HudSettings, touchMode: boolean): boolean {
  return !touchMode || !HUD_TOUCH_HIDDEN.includes(key);
}
