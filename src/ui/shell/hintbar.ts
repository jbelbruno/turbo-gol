/**
 * The hint bar (`mn-hintbar`, plan §1.3 and §1.6), the footer zone: the verbs of the last input on
 * the left (hints.ts: glyph + verb pairs, none for a mouse or a finger), and on the right the
 * source link (AGPL-3.0, section 13: a network game offers its source to its players; it never
 * goes, though it may take its short form, "Source (AGPL-3.0)") and About (a sheet with the build
 * line, the third-party licenses and Discord). A TV keeps its pills here (Menu.placePills: its top
 * bar has no room at 3 m). On an upright phone it is the
 * 32 px link line above the tabs; a phone held sideways has the rail's foot instead.
 * Once GET /api/config names a terms version (the owner published them: Menu.loadConfig), Inicio's
 * bar links the terms and the privacy policy after About too (legal: the legal draft's P12, links
 * on the home page; shell.css shows them on Inicio only, where every screen's About lists them).
 * Built on call, nothing at import.
 */
import { h } from '../dom';
import { language, t } from '../../i18n';
import { glyph } from '../components/glyphs';
import type { HintItem } from './hints';
import { LICENSE_NAME, SOURCE_URL } from '../../brand';
import { legalPaths } from '../../net/terms';

export class HintBar {
  readonly el: HTMLElement;
  /** Between the hints and the links: the pills on a TV. */
  readonly mid: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly links: HTMLElement;
  private key = '';
  private legalShown = false;

  constructor(about: () => void) {
    this.hints = h('div.mn-hints');
    this.mid = h('div.mn-hint-mid');
    // data-fit (fit.ts): crowded (a TV's pills, a controller's four hints, Spanish, a wide fallback
    // face), the bar's text comes down to 14 px (16 on a TV, at its reference view) as one, then the
    // source link takes its short form; then what gives way (data-fit-give): the controller's ≡
    // Settings (1), the TV's pills' words (2 and 3: pills.ts), the hint to cancel the search (4).
    // The source link never goes (a TV's About gives way to a running search: shell.css).
    this.el = h(
      'footer.mn-hint',
      { 'data-fit': '14' },
      this.hints,
      this.mid,
      (this.links = h(
        'div.mn-links',
        null,
        h(
          'a.mn-link',
          { href: SOURCE_URL, target: '_blank', rel: 'noopener', title: t('menu.sourceTitle', { license: LICENSE_NAME }), 'data-nav': true, 'data-key': 'source' },
          h('span', { 'data-fit-alt': t('menu.sourceShort', { license: LICENSE_NAME }) }, t('menu.sourceTitle', { license: LICENSE_NAME })),
        ),
        h('span.mn-link-sep', { 'aria-hidden': 'true' }, '·'),
        h('button.mn-link.mn-link-about', { type: 'button', 'data-nav': true, 'data-key': 'about', onclick: about }, t('nav.about')),
      )),
    );
  }

  /** The hints; nothing is written when they did not change (false then: the bar needs no new fit). */
  render(items: readonly HintItem[]): boolean {
    const key = items.map((i) => i.glyphs.join('+') + ':' + i.verb).join('|');
    if (key === this.key) return false;
    this.key = key;
    this.hints.textContent = '';
    for (const it of items) this.hints.appendChild(h('span.mn-hint-item', { 'data-fit-give': it.give !== undefined ? String(it.give) : undefined }, ...it.glyphs.map(glyph), h('span.mn-hint-verb', null, t(it.verb))));
    return true;
  }

  /**
   * Terms · Privacy after About (`mn-links-legal`), in the player's language, once `version` (GET
   * /api/config legal.terms) is in force; nothing while it is null (unpublished), and once only.
   * The short names, the full ones as titles; a new tab, but on a TV (where Back returns to the
   * game). Inicio's bar only (shell.css), on its own second line on an upright phone, whose one line
   * has no room for four links in Spanish (`mn-hint-legal`). A crowded bar fits as before (a TV's
   * with a controller: the source link's short form, then ≡ Settings gives way). True when added.
   */
  legal(version: string | null): boolean {
    if (version === null || this.legalShown) return false;
    this.legalShown = true;
    const paths = legalPaths(language());
    const tv = document.documentElement.classList.contains('tg-tv');
    const sep = (): HTMLElement => h('span.mn-link-sep', { 'aria-hidden': 'true' }, '·');
    const link = (kind: 'terms' | 'privacy', text: string, title: string): HTMLElement =>
      h('a.mn-link', { href: paths[kind], target: tv ? undefined : '_blank', rel: 'noopener', title, 'data-nav': true, 'data-key': 'legal-' + kind }, text);
    this.links.appendChild(h('span.mn-links-legal', null, sep(), link('terms', t('legal.termsLink'), t('legal.terms')), sep(), link('privacy', t('legal.privacyShort'), t('legal.privacy'))));
    this.el.classList.add('mn-hint-legal');
    return true;
  }
}
