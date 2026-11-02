/**
 * What the LED boards show (pure data; textures.ts draws it): Turbogol only, the same set in every
 * stadium (the owner, 2026-11: no invented sponsors). A set holds BOARD_CARDS board cards (the
 * TURBOGOL name with a tagline, an emblem and a colourway; neighbouring slots differ, so the change
 * reads as a wave round the stadium, boards.ts) and the two cards of the big side-wall board
 * (main, secondary: the wide layout, not among the cards).
 */
import type { ThemeId } from '../theme';
import type { EmblemId } from './emblems';

export type Place = 'harbour' | 'canyon' | 'alpine';

/** The place each theme stands in (the harbour by night and by day share one set). */
export const THEME_PLACE: Readonly<Record<ThemeId, Place>> = {
  'harbour-night': 'harbour',
  'canyon-sunset': 'canyon',
  'alpine-day': 'alpine',
};

export interface BoardCard {
  readonly name: string;
  readonly tag: string;
  readonly logo: EmblemId;
  /** Background gradient (top, bottom), text colour, accent / emblem colour. */
  readonly bg: readonly [string, string];
  readonly fg: string;
  readonly ac: string;
}

export interface ContentSet {
  readonly cards: readonly BoardCard[];
  /** The big side-wall board's two sponsors (textures.ts drawBigCard). */
  readonly main: BoardCard;
  readonly secondary: BoardCard;
}

// ---- Turbogol only ---------------------------------------------------------------------------

/** The brand's name on every card. */
export const BRAND = 'TURBOGOL';

type Look = Pick<BoardCard, 'bg' | 'fg' | 'ac'>;
/** Colourways: night with the lime accent, lime, blue, red. */
const LOOKS: readonly Look[] = [
  { bg: ['#0a0e17', '#04060b'], fg: '#ffffff', ac: '#c6ff2e' },
  { bg: ['#c6ff2e', '#9fd61a'], fg: '#0a0e17', ac: '#0a0e17' },
  { bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#3a9bff' },
  { bg: ['#8a0f24', '#5a0814'], fg: '#ffffff', ac: '#ff9aa8' },
];
/** Taglines with their emblem. */
const LINES: readonly (readonly [string, EmblemId])[] = [
  ['turbo-gol.com', 'chevrons'],
  ['JUEGA GRATIS', 'ball'],
  ['FÚTBOL CON AUTOS', 'chevrons'],
  ['MÁS GOL.', 'bolt'],
  ['1V1 · 2V2 · 3V3', 'ball'],
  ['CÓDIGO ABIERTO', 'chevrons'],
  ['EN EL NAVEGADOR', 'bolt'],
];

const card = (i: number): BoardCard => {
  const [tag, logo] = LINES[i % LINES.length];
  return { name: BRAND, tag, logo, ...LOOKS[i % LOOKS.length] };
};

/** One set for every stadium: 20 cards (7 taglines x 4 colourways, so no two neighbours match). */
const SET: ContentSet = {
  cards: Array.from({ length: 20 }, (_, i) => card(i)),
  main: { name: BRAND, tag: 'turbo-gol.com', logo: 'chevrons', ...LOOKS[0] },
  secondary: { name: BRAND, tag: 'JUEGA GRATIS', logo: 'ball', ...LOOKS[1] },
};

export const CONTENT: Readonly<Record<Place, ContentSet>> = { harbour: SET, canyon: SET, alpine: SET };

/** The board content of a theme. */
export function themeContent(theme: ThemeId): ContentSet {
  return CONTENT[THEME_PLACE[theme]];
}
