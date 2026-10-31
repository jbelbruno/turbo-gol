/**
 * The account deletion's screens (the legal draft's P5; the API is sign-in PR 12's: POST
 * /api/me/delete, the 14 days to cancel, M9's cancel link). Every one of them only while GET
 * /api/config says the server takes deletions (AccountClient.authConfig `deletion`, DELETION_OPEN:
 * "0" in production until the owner publishes the terms); before that each caller does what it did.
 *
 *   PERFIL's BORRAR CUENTA (profile.ts deleteDialog) asks the username typed and "confirm it's you"
 *   at the level the server asks, then shows deletionDone:
 *   deletionDone(menu, ...)    "Borrado pedido": the day it goes, that a mail with the cancel link
 *                              went (an account with an address), and the receipt on screen (the
 *                              legal draft's P5: an account without an address gets no mail)
 *   pendingSheet(menu, ...)    a sign-in of an account whose deletion is pending (409 deletion_pending
 *                              { purgeAt }, or the OAuth callback's /#auth=error:deletion_pending):
 *                              "Esta cuenta se va a borrar", the day, CONSERVAR MI CUENTA (the same
 *                              sign-in again with cancelDeletion, or the provider's with cancelDel=1)
 *                              and CANCELAR
 *   openKeepSheet(menu, token) M9's link (/account#keep=<token>): "¿Conservar tu cuenta?", nothing
 *                              changes until CONSERVAR MI CUENTA (POST /api/auth/delete/cancel: a mail
 *                              scanner's visit does nothing), then "Tu cuenta sigue"
 */
import { h } from '../dom';
import type { Menu } from '../Menu';
import { AccountError } from '../../net/AccountClient';
import type { OAuthProvider } from '../../net/account';
import { errText } from './profile';
import { legalState } from '../../net/terms';
import { language, t } from '../../i18n';

/** The server takes deletions now (DELETION_OPEN): its screens show. False offline or from an older server. */
export async function deletionOn(menu: Menu): Promise<boolean> {
  return (await legalState(menu.host.accounts)).deletion;
}

/** A day in the page's language ("14/11/2026", "11/14/2026"). */
export function dayText(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(language());
  } catch {
    return new Date(ms).toDateString();
  }
}

/** A day and a time in the page's language (the receipt's request). */
export function dayTimeText(ms: number): string {
  try {
    return new Date(ms).toLocaleString(language());
  } catch {
    return new Date(ms).toString();
  }
}

/**
 * After POST /api/me/delete answered: the day the account goes (`purgeAt`), that its cancel link was
 * mailed (`mailed`: an account with a verified address), and the receipt on screen with the
 * request's time, for every account (one without an address gets nothing else).
 */
export function deletionDone(menu: Menu, name: string, purgeAt: number, mailed: boolean, now: number = Date.now()): void {
  menu.modal({
    title: t('delete.doneTitle'),
    body: [
      h('p', null, t('delete.done', { name, date: dayText(purgeAt) })),
      mailed ? h('p.mn-note', null, t('delete.doneMail')) : null,
      h('p.mn-note.mn-delete-receipt', { role: 'status' }, t('delete.receipt', { name, when: dayTimeText(now), date: dayText(purgeAt) })),
    ],
    actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }],
  });
}

/**
 * "Esta cuenta se va a borrar" (a sign-in answered deletion_pending): the day when the answer said
 * it (`purgeAt`, 0 when not: the OAuth callback), CONSERVAR MI CUENTA runs `keep` (the sign-in
 * again with cancelDeletion; a refusal says why and keeps the sheet), CANCELAR. Resolves true once
 * the account was kept, false when the sheet closed otherwise.
 */
export function pendingSheet(menu: Menu, purgeAt: number, keep: () => Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let kept = false;
    const err = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
    menu.modal({
      title: t('delete.pendingTitle'),
      body: [h('p.mn-note', null, purgeAt > 0 ? t('delete.pendingNote', { date: dayText(purgeAt) }) : t('delete.pendingNoteNoDate')), err],
      actions: [
        {
          label: t('delete.keepBtn'),
          primary: true,
          autofocus: true,
          onClick: async () => {
            err.hidden = true;
            try {
              await keep();
            } catch (e) {
              err.textContent = errText(e);
              err.hidden = false;
              return false;
            }
            kept = true;
            return true;
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
      onClose: () => resolve(kept),
    });
  });
}

/**
 * Back from a provider with /#auth=error:deletion_pending (Game.restoreAccount): with the deletion
 * screens open and the provider this tab started known, the pending sheet, whose CONSERVAR MI
 * CUENTA signs in with that provider again asking to call the deletion off (start?cancelDel=1).
 * False (nothing shown) otherwise: the caller says the error as before.
 */
export async function pendingFromProvider(menu: Menu, provider: OAuthProvider | null): Promise<boolean> {
  if (provider === null || !(await deletionOn(menu))) return false;
  const acc = menu.host.accounts;
  // The menus up and no other sheet (the page is still loading: the other URL sheets wait the same way).
  while (!menu.visible || menu.modalOpen) await new Promise((r) => setTimeout(r, 200));
  void pendingSheet(menu, 0, async () => {
    acc.providerStarted(provider);
    window.location.href = acc.oauthUrl(provider, 'cancelDel');
  });
  return true;
}

/**
 * M9's link (/account#keep=<token>), from any device, signed in or not: "¿Conservar tu cuenta?";
 * nothing changes until CONSERVAR MI CUENTA (POST /api/auth/delete/cancel), then "Tu cuenta sigue".
 * A dead link (used, expired, the account gone) says so. With the deletion screens closed, as
 * before them: the link is not valid here.
 */
export async function openKeepSheet(menu: Menu, token: string): Promise<void> {
  const acc = menu.host.accounts;
  if (!(await deletionOn(menu))) {
    acc.keepPendingLink(null);
    menu.toast(t('error.account.link_invalid'), 'error');
    return;
  }
  const err = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
  menu.modal({
    title: t('delete.keepTitle'),
    body: [h('p.mn-note', null, t('delete.keepNote')), err],
    actions: [
      {
        label: t('delete.keepBtn'),
        primary: true,
        onClick: async () => {
          err.hidden = true;
          try {
            await acc.cancelDeletion(token);
          } catch (e) {
            err.textContent = e instanceof AccountError && e.code === 'link_invalid' ? t('error.account.link_invalid') : errText(e);
            err.hidden = false;
            return false;
          }
          queueMicrotask(() => menu.modal({ title: t('delete.keptTitle'), body: h('p', null, t('delete.kept')), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] }));
          return true;
        },
      },
      { label: t('profile.cancel'), onClick: () => true },
    ],
    // Closed (CANCELAR, Back, a sheet over it): the next page load does not bring it back; the mail's link still works.
    onClose: () => acc.keepPendingLink(null),
  });
}
