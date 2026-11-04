/**
 * "While you search" (the modes redesign, November 2026: spec §3.4): the sheet a search started
 * from Inicio's hero or the FINAL's PLAY AGAIN opens on its first waiting answer (which comes at
 * once: the server answers a new search without the long-poll), after the terms and the sign-in,
 * never before; MODOS' searching panel has the same choice inline, so it never opens there, nor for
 * a search matched on its first answer. VS BOTS (an unlimited match against the bots, ended by the
 * match found), TRAIN (free play; the shot packs from TRAINING) or STAY IN THE MENU (the found cue
 * plays, the tab's title changes). The focus starts on the last pick (MenuPrefs.waitChoice); a
 * sheet rises from the bottom on a phone (components/sheet.ts), Back closes it as STAY does.
 */
import { h } from '../dom';
import { t } from '../../i18n';
import type { Key } from '../../i18n';
import type { Menu } from '../Menu';
import type { WaitChoice } from '../prefs';
import { icon } from '../components/icons';
import type { IconName } from '../components/icons';

const CHOICES: ReadonlyArray<{ id: WaitChoice; icon: IconName; title: Key; sub: Key }> = [
  { id: 'bots', icon: 'bot', title: 'wait.bots', sub: 'wait.botsSub' },
  { id: 'training', icon: 'training', title: 'wait.training', sub: 'wait.trainingSub' },
  { id: 'menu', icon: 'audio', title: 'wait.menu', sub: 'wait.menuSub' },
];

/** Open the sheet over the menus; a choice is remembered for the next one. */
export function openWaitSheet(menu: Menu): void {
  const last = menu.prefs.waitChoice;
  let close = (): void => undefined;
  const choose = (c: WaitChoice): void => {
    if (menu.prefs.waitChoice !== c) {
      menu.prefs.waitChoice = c;
      menu.savePrefs();
    }
    close();
    // The search may have found its match meanwhile: the host starts nothing then.
    if (c !== 'menu') menu.host.waitPlay(c);
  };
  const option = (c: (typeof CHOICES)[number]): HTMLButtonElement =>
    h(
      `button.mn-btn.mn-sheet-option.mn-wait-option${c.id === last ? '.mn-sheet-option-on' : ''}` as 'button',
      { type: 'button', 'data-nav': true, 'data-key': 'wait-' + c.id, 'data-autofocus': c.id === last, onclick: () => choose(c.id) },
      icon(c.icon),
      h('span.mn-net-text', null, h('b', null, t(c.title)), h('small', null, t(c.sub))),
    );
  close = menu.modal({ title: t('wait.title'), body: h('div.mn-sheet-list.mn-wait-list', null, ...CHOICES.map(option)), actions: [] });
}
