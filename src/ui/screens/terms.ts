/**
 * The terms of service and the privacy policy in the menus (the legal draft's P1, P2, P12, P33).
 * All of it only once GET /api/config names a version in force (AccountClient.authConfig `terms`,
 * null until the owner publishes: then nothing here shows, and termsGate resolves at once).
 *
 *   termsNotice(menu, button)  the short notice with its two links, right above the button that
 *                              accepts (D31's text): JUGAR COMO INVITADO on the guest sheet, CREAR
 *                              CUENTA on PERFIL's sign-up and on the mailed link's finish sheet, NO,
 *                              CREAR MI CUENTA on the OAuth confirm step; empty and hidden until the
 *                              config says a version, and `version()` is what it showed (the version a
 *                              press accepts: none when nothing showed)
 *   termsGate(menu, guest)     NetClient.beforeSession, before a session is used online (a queue, a
 *                              lobby, a rejoin): a guest that has not accepted this version gets the
 *                              guest sheet ("Antes de jugar": the notice, JUGAR COMO INVITADO, CANCELAR)
 *                              and its press is kept in this browser (src/net/terms.ts GuestTerms); an
 *                              account whose /api/me `terms` is not it (a change, or an account of
 *                              before) gets the re-accept sheet (the notice, ACEPTAR Y JUGAR, CANCELAR:
 *                              POST /api/me/consent { kind: 'terms', version }, a TV's too). CANCELAR,
 *                              Back or a sheet over it rejects (TermsDeclined, a NetError 'cancelled':
 *                              the queue stops without a word). One sheet for every caller at once.
 *   legalLinks(menu, cls)      TÉRMINOS DE USO and POLÍTICA DE PRIVACIDAD (the About sheet, PERFIL's
 *                              ACERCA DE), filled once the config names a version
 *
 * A link opens its page in a new tab, so the sheet stays (on a TV, where tabs are awkward, in this
 * one: Back returns to the game). The pages are server/src/legalPages.ts's.
 */
import { h } from '../dom';
import type { Menu } from '../Menu';
import { NetError } from '../../net/NetClient';
import { legalPaths, legalState, termsNeeded } from '../../net/terms';
import type { GuestTerms } from '../../net/terms';
import { errText } from './profile';
import { language, t } from '../../i18n';

/** The player closed the acceptance sheet: the online step that asked stops, quietly (OnlineSession treats 'cancelled' as a cancel). */
export class TermsDeclined extends NetError {
  constructor() {
    super('cancelled', 'terms not accepted');
  }
}

/** A TV (device.ts tg-tv): a link opens in this tab. */
function onTv(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('tg-tv');
}

/** One link to a page, in the player's language. */
export function legalLink(kind: 'terms' | 'privacy', text: string, cls = 'mn-link'): HTMLAnchorElement {
  const href = legalPaths(language())[kind];
  return h(`a.${cls.trim().replace(/\s+/g, '.')}` as 'a', { href, target: onTv() ? undefined : '_blank', rel: 'noopener', 'data-nav': true, 'data-key': 'legal-' + kind }, text);
}

/** The notice's sentence with its two links in place of {terms} and {privacy}. */
function noticeNodes(button: string): Array<Node | string> {
  const text = t('legal.notice', { button });
  const out: Array<Node | string> = [];
  for (const part of text.split(/(\{terms\}|\{privacy\})/)) {
    if (part === '{terms}') out.push(legalLink('terms', t('legal.termsLink'), 'mn-legal-link'));
    else if (part === '{privacy}') out.push(legalLink('privacy', t('legal.privacyLink'), 'mn-legal-link'));
    else if (part !== '') out.push(part);
  }
  return out;
}

/** The notice's paragraph for `version` (the sheets build it once the version is known). */
function noticeFor(button: string, version: string): HTMLElement {
  return h('p.mn-note.mn-legal-notice', { 'data-terms': version }, ...noticeNodes(button));
}

/**
 * The notice above a button that accepts (`button`: its label as shown). Hidden and empty until the
 * config names a version; `version()` is the one it shows, null while it shows none.
 */
export function termsNotice(menu: Menu, button: string): { el: HTMLElement; version: () => string | null } {
  const el = h('p.mn-note.mn-legal-notice', { hidden: true });
  let shown: string | null = null;
  void legalState(menu.host.accounts).then((c) => {
    if (c.terms === null) return;
    shown = c.terms;
    el.setAttribute('data-terms', c.terms);
    for (const n of noticeNodes(button)) el.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
    el.hidden = false;
    menu.refit();
  });
  return { el, version: () => shown };
}

/** TÉRMINOS DE USO and POLÍTICA DE PRIVACIDAD, appended to `into` once the config names a version (nothing before). */
export function legalLinks(menu: Menu, into: HTMLElement, cls = 'mn-link'): void {
  void legalState(menu.host.accounts).then((c) => {
    if (c.terms === null) return;
    into.appendChild(legalLink('terms', t('legal.terms'), cls));
    into.appendChild(legalLink('privacy', t('legal.privacy'), cls));
  });
}

/** The one acceptance sheet up now (a guest's or an account's), shared by every caller of that kind that asks meanwhile. */
let asking: { account: boolean; version: string; p: Promise<void> } | null = null;

/**
 * NetClient.beforeSession: resolves at once with no version in force, a guest that accepted it in
 * this browser, or an account whose newest acceptance is it; otherwise once the player pressed the
 * sheet's button (the acceptance kept or sent first). Rejects with TermsDeclined when the sheet
 * closes otherwise, or `signal` aborts. An account whose profile cannot be read (offline) is asked
 * nothing: its online step fails on its own.
 */
export async function termsGate(menu: Menu, guestTerms: GuestTerms, account: boolean, signal?: AbortSignal): Promise<void> {
  const acc = menu.host.accounts;
  const version = (await legalState(acc)).terms;
  if (version === null) return;
  if (!account) {
    if (!termsNeeded(version, guestTerms.accepted())) return;
  } else {
    const me = acc.me !== null && acc.me.playerId === acc.account?.playerId ? acc.me : await acc.fetchMe().catch(() => null);
    if (me === null || me.terms === undefined || !termsNeeded(version, me.terms)) return;
  }
  // Another kind's sheet up (a sign-in since): this one replaces it, and its callers hear a refusal.
  if (asking === null || asking.account !== account || asking.version !== version) {
    const p = account ? reacceptSheet(menu, version) : guestSheet(menu, guestTerms, version);
    const mine = { account, version, p };
    asking = mine;
    const done = (): void => {
      if (asking === mine) asking = null;
    };
    p.then(done, done);
  }
  const p = asking.p;
  if (signal === undefined) return p;
  if (signal.aborted) throw new TermsDeclined();
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new TermsDeclined());
    signal.addEventListener('abort', abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * The re-accept sheet asked for by an account's own step, not by an online session: "Mis servidores"
 * when the terms in force are what it still lacks (Prompt 2, B2: PR 2A's "the general re-accept sheet
 * comes first"). Resolves once accepted (at once with no version in force); rejects when closed.
 */
export async function reacceptTerms(menu: Menu): Promise<void> {
  const version = (await legalState(menu.host.accounts)).terms;
  if (version === null) return;
  return reacceptSheet(menu, version);
}

/** "Antes de jugar": the notice and JUGAR COMO INVITADO (the press accepts, kept in this browser), CANCELAR. */
function guestSheet(menu: Menu, guestTerms: GuestTerms, version: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let accepted = false;
    const play = t('legal.playAsGuest');
    menu.modal({
      title: t('legal.beforeTitle'),
      body: [h('p.mn-note.mn-legal-note', null, t('legal.guestNote')), noticeFor(play, version)],
      actions: [
        {
          label: play,
          primary: true,
          autofocus: true,
          onClick: () => {
            accepted = true;
            guestTerms.accept(version);
            return true;
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
      onClose: () => (accepted ? resolve() : reject(new TermsDeclined())),
    });
  });
}

/**
 * The re-accept sheet: "Cambiaron los Términos" (or "Antes de jugar" for an account that never
 * accepted any), the notice and ACEPTAR Y JUGAR (POST /api/me/consent: a refusal says why and keeps
 * the sheet), CANCELAR. Where PERFIL can delete the account (DELETION_OPEN), the note says so (Terms
 * §18.3: whoever does not accept may leave at no cost).
 */
function reacceptSheet(menu: Menu, version: string): Promise<void> {
  const acc = menu.host.accounts;
  return new Promise<void>((resolve, reject) => {
    let accepted = false;
    const changed = typeof acc.me?.terms === 'string';
    const go = t('legal.acceptAndPlay');
    const err = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
    void legalState(acc).then((c) => {
      if (c.deletion && note.isConnected) note.textContent = t(changed ? 'legal.changedNote' : 'legal.accountNote') + ' ' + t('legal.orDelete');
    });
    const note = h('p.mn-note.mn-legal-note', null, t(changed ? 'legal.changedNote' : 'legal.accountNote'));
    menu.modal({
      title: t(changed ? 'legal.changedTitle' : 'legal.beforeTitle'),
      body: [note, noticeFor(go, version), err],
      actions: [
        {
          label: go,
          primary: true,
          autofocus: true,
          onClick: async () => {
            err.hidden = true;
            try {
              await acc.acceptTerms(version);
            } catch (e) {
              err.textContent = errText(e);
              err.hidden = false;
              return false;
            }
            accepted = true;
            return true;
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
      onClose: () => (accepted ? resolve() : reject(new TermsDeclined())),
    });
  });
}
