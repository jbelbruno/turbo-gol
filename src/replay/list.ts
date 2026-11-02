/**
 * The replay list (replay.html without ?id): the matches the community servers played in the
 * last 30 days (src/net/replays.ts), newest hour first, a page at a time; each shows the hour it
 * ended in (the server rounds it), never the minute. A scoreboard card per match (blue side, the
 * score, red side; the winner lit) with its star count, filters by kind and format over what is
 * loaded, and three views of the matches: the latest (paged), the most starred and, for a
 * registered account, its own ("My replays", which can be starred-sorted too). Only a registered
 * account stars (a guest sees the counts); the server keeps who starred, never shows it. Every
 * text goes in as textContent: names come from players (a hidden one, 'Jugador N', in this page's
 * language: names.ts).
 */
import { t } from '../i18n';
import type { Key } from '../i18n';
import { AccountClient } from '../net/AccountClient';
import type { AccountSession } from '../net/account';
import { PROTOCOL_VERSION } from '../net/protocol';
import { fetchMyReplays, fetchMyStars, fetchReplayList, fetchTopReplays, setReplayStar } from '../net/replays';
import type { ReplayBuild, ReplayListItem } from '../net/replays';
import { ROCKETSIM_WASM_SHA256 } from '../sim/wasm/rocketsim.sha256';
import { TICK_RATE } from '../sim/types';
import { replayName } from './names';

type Child = Node | string | null;

/** A small element builder: `tag.class1.class2`, attributes, children (strings become text). */
export function el(spec: string, attrs: Record<string, string> | null = null, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split('.');
  const e = document.createElement(tag || 'div');
  const cls = classes.filter((c) => c.length > 0);
  if (cls.length > 0) e.className = cls.join(' ');
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

/** True when the match was played on this client's simulation (the control plane's sameBuild). */
export function sameBuild(b: ReplayBuild): boolean {
  return b.wasmSha256 === ROCKETSIM_WASM_SHA256 && b.protocol === PROTOCOL_VERSION;
}

export function clockText(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function regionName(r: string): string {
  const key = `region.${r}` as Key;
  const text = t(key);
  return text === key ? r : text;
}

/** What a card needs from the page: the star toggle. */
interface CardCtx {
  onStar: (m: ReplayListItem, card: HTMLElement) => void;
}

/** One match as a scoreboard card: a cover link to watch it, and its star (a button above the link). */
function card(m: ReplayListItem, ctx: CardCtx): HTMLElement {
  const side = (n: 0 | 1): HTMLElement => {
    // A guest's server name ('Invitado 4821') and a hidden one ('Jugador 3') in this page's language.
    const names = m.players.filter((p) => p.team === n).map((p) => (p.bot ? `${p.name} (${t('replay.bot')})` : replayName(p.name)));
    const text = names.join(', ') || '-';
    const win = n === 0 ? m.blue > m.red : m.red > m.blue;
    return el(`div.rp-side.${n === 0 ? 'rp-blue' : 'rp-red'}.${win ? 'rp-win' : ''}`, { title: text }, el('span.rp-dot'), el('span.rp-names', null, text));
  };
  const when = new Date(m.at).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const chips: HTMLElement[] = [
    el(`span.rp-chip.${m.ranked ? 'rp-gold' : ''}`, null, m.ranked ? t('replay.ranked') : t('replay.casual')),
    el('span.rp-chip', null, m.mode),
    el('span.rp-chip', null, regionName(m.region)),
    el(`span.rp-chip.${m.verified ? 'rp-ok' : 'rp-warn'}`, null, m.verified ? t('replay.verified') : t('replay.unverified')),
  ];
  if (!sameBuild(m.build)) chips.push(el('span.rp-chip.rp-warn', null, t('replay.otherVersion')));
  const score = el('div.rp-score', null, el(`span.rp-b.${m.blue > m.red ? 'rp-win' : ''}`, null, String(m.blue)), el('span.rp-sep', null, '–'), el(`span.rp-r.${m.red > m.blue ? 'rp-win' : ''}`, null, String(m.red)));
  const star = el('button.rp-star', { type: 'button', 'aria-pressed': 'false' }, el('span.rp-staricon'), el('span.rp-starn', null, String(m.stars ?? 0)));
  const c = el(
    'div.rp-card',
    { 'data-kind': m.ranked ? 'ranked' : 'casual', 'data-mode': m.mode, 'data-id': m.matchId },
    el('a.rp-cover', { href: `?id=${m.matchId}`, 'aria-label': t('replay.watch') }),
    el('div.rp-bar'),
    el('div.rp-board', null, side(0), score, side(1)),
    el(
      'div.rp-foot',
      null,
      el('div.rp-meta', null, el('span', null, when), m.ticks > 0 ? el('span', null, clockText(m.ticks)) : null, ...chips),
      el('div.rp-actions', null, star, el('span.rp-go', null, el('span.rp-tri'), t('replay.watch'))),
    ),
  );
  star.addEventListener('click', () => ctx.onStar(m, c));
  return c;
}

const skeletons = (rows: HTMLElement): void => {
  for (let i = 0; i < 3; i++) rows.append(el('div.rp-skel', { 'aria-hidden': 'true' }));
};

type Source = 'recent' | 'top' | 'mine';

/** Fill `root` with the list; `openFile` plays a local file (a maintainer's download). */
export function showList(root: HTMLElement, openFile: (f: File) => void): void {
  document.title = `${t('replay.title')} · Turbogol`;
  const rows = el('div.rp-rows');
  // The first page's placeholders: three cards that breathe until the answer comes.
  skeletons(rows);
  const note = el('p.rp-note.rp-hidden', null, '');
  const more = el('button.rp-btn', { type: 'button' }, t('replay.more'));
  const moreLine = el('div.rp-more.rp-hidden', null, more);
  const file = el('input', { type: 'file', accept: '.tgr,application/octet-stream', hidden: '' }) as HTMLInputElement;
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) openFile(f);
  });
  const fileBtn = el('button.rp-btn.rp-ghost', { type: 'button' }, t('replay.openFile'));
  fileBtn.addEventListener('click', () => file.click());

  // The account (a registered one stars and has "My replays"); the ids it starred.
  let session: AccountSession | null = null;
  let starred = new Set<string>();
  const items = new Map<string, ReplayListItem>();

  // Filters: kind and format (over what is loaded), the account's own, and the order.
  const filter = { kind: 'all', mode: 'all', mine: false, sort: 'new' };
  const chipOf = (group: string, value: string, text: string, pressed = value === 'all' || value === 'new'): HTMLButtonElement =>
    el('button.rp-fchip', { type: 'button', 'aria-pressed': pressed ? 'true' : 'false', 'data-group': group, 'data-value': value }, text) as HTMLButtonElement;
  const mineChip = chipOf('mine', 'on', t('replay.mine'), false);
  mineChip.classList.add('rp-hidden');
  const chips: HTMLButtonElement[] = [
    chipOf('kind', 'all', t('replay.all')),
    chipOf('kind', 'ranked', t('replay.ranked')),
    chipOf('kind', 'casual', t('replay.casual')),
    chipOf('mode', 'all', t('replay.anyFormat')),
    chipOf('mode', '1v1', '1v1'),
    chipOf('mode', '2v2', '2v2'),
    chipOf('mode', '3v3', '3v3'),
    chipOf('sort', 'new', t('replay.sortNew')),
    chipOf('sort', 'stars', t('replay.sortStars')),
  ];
  const filtersEl = el(
    'div.rp-filters',
    null,
    el('div.rp-fgroup', null, ...chips.slice(0, 3), mineChip),
    el('div.rp-fgroup', null, ...chips.slice(3, 7)),
    el('div.rp-fgroup', null, ...chips.slice(7)),
  );
  const none = el('p.rp-note.rp-hidden', null, t('replay.noneFiltered'));
  const apply = (): void => {
    let shown = 0;
    let total = 0;
    for (const c of rows.querySelectorAll<HTMLElement>('.rp-card')) {
      total++;
      const ok = (filter.kind === 'all' || c.dataset.kind === filter.kind) && (filter.mode === 'all' || c.dataset.mode === filter.mode);
      c.classList.toggle('rp-hidden', !ok);
      if (ok) shown++;
    }
    none.classList.toggle('rp-hidden', total === 0 || shown > 0);
  };

  // The stars: each card shows its count; the account's own are lit; a guest's is locked.
  const paintStars = (): void => {
    for (const c of rows.querySelectorAll<HTMLElement>('.rp-card')) {
      const id = c.dataset.id ?? '';
      const m = items.get(id);
      const b = c.querySelector<HTMLButtonElement>('.rp-star');
      if (!b || !m) continue;
      const on = starred.has(id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('rp-on', on);
      b.classList.toggle('rp-locked', session === null);
      b.title = session === null ? t('replay.starSignIn') : on ? t('replay.unstar') : t('replay.star');
      const n = b.querySelector('.rp-starn');
      if (n) n.textContent = String(m.stars ?? 0);
    }
  };
  const ctx: CardCtx = {
    onStar: (m) => {
      if (session === null) return;
      const on = !starred.has(m.matchId);
      // At once, then what the server says; a refusal puts it back.
      if (on) starred.add(m.matchId);
      else starred.delete(m.matchId);
      m.stars = Math.max(0, (m.stars ?? 0) + (on ? 1 : -1));
      paintStars();
      setReplayStar(session.session, m.matchId, on).then(
        (r) => {
          m.stars = r.stars;
          paintStars();
        },
        () => {
          if (on) starred.delete(m.matchId);
          else starred.add(m.matchId);
          m.stars = Math.max(0, (m.stars ?? 0) + (on ? -1 : 1));
          paintStars();
        },
      );
    },
  };

  root.replaceChildren(
    el(
      'div.rp-wrap',
      null,
      el(
        'header.rp-top',
        null,
        el('a.rp-brand', { href: './', 'aria-label': t('replay.back') }, el('span.rp-brand-a', null, 'TURBO'), el('span.rp-brand-b', null, 'GOL')),
        el('a.rp-btn', { href: './' }, el('span.rp-back'), t('replay.back')),
      ),
      el('section.rp-hero', null, el('span.rp-eyebrow', null, t('replay.eyebrow')), el('h1.rp-h1', null, t('replay.heading')), el('p.rp-intro', null, t('replay.intro'))),
      filtersEl,
      rows,
      none,
      note,
      moreLine,
      el('footer.rp-foot-file', null, fileBtn, file),
    ),
  );

  let next: string | null = null;
  let busy = false;
  /** Bumped by every change of view: an answer of a view left behind is dropped. */
  let gen = 0;
  const source = (): Source => (filter.mine ? 'mine' : filter.sort === 'stars' ? 'top' : 'recent');
  const emptyText = (): string => (source() === 'mine' ? t('replay.mineEmpty') : source() === 'top' ? t('replay.topEmpty') : t('replay.empty'));
  const clearSkeletons = (): void => {
    for (const s of rows.querySelectorAll('.rp-skel')) s.remove();
  };
  const add = (list: ReplayListItem[]): void => {
    for (const m of list) {
      items.set(m.matchId, m);
      rows.append(card(m, ctx));
    }
    paintStars();
  };
  const load = async (before: string | null): Promise<void> => {
    if (busy) return;
    busy = true;
    const mine = gen;
    const src = source();
    more.setAttribute('disabled', '');
    try {
      if (src === 'recent') {
        const page = await fetchReplayList(before);
        if (mine !== gen) return;
        clearSkeletons();
        add(page.matches);
        next = page.next;
      } else {
        const list = src === 'top' ? await fetchTopReplays() : await fetchMyReplays(session?.session ?? '');
        if (mine !== gen) return;
        clearSkeletons();
        // "My replays" by stars: the account's own matches, the most starred first (the sort is stable).
        add(src === 'mine' && filter.sort === 'stars' ? [...list].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)) : list);
        next = null;
      }
      apply();
      note.classList.toggle('rp-hidden', rows.childElementCount > 0);
      note.textContent = emptyText();
    } catch (e) {
      if (mine !== gen) return;
      clearSkeletons();
      const unavailable = e instanceof Error && e.message === 'HTTP 404';
      note.classList.remove('rp-hidden');
      note.replaceChildren(unavailable ? t('replay.unavailable') : t('replay.error'));
      if (!unavailable) {
        const retry = el('button.rp-btn', { type: 'button' }, t('replay.retry'));
        retry.addEventListener('click', () => {
          note.classList.add('rp-hidden');
          skeletons(rows);
          void load(before);
        });
        note.append(' ', retry);
      }
    } finally {
      if (mine === gen) {
        busy = false;
        more.removeAttribute('disabled');
        moreLine.classList.toggle('rp-hidden', next === null);
      }
    }
  };
  /** A change of view (my replays on or off, the order): start over from the first page. */
  const reload = (): void => {
    gen++;
    busy = false;
    next = null;
    rows.replaceChildren();
    skeletons(rows);
    note.classList.add('rp-hidden');
    none.classList.add('rp-hidden');
    moreLine.classList.add('rp-hidden');
    void load(null);
  };

  filtersEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.rp-fchip');
    if (!b) return;
    const group = b.dataset.group ?? 'kind';
    const value = b.dataset.value ?? 'all';
    if (group === 'mine') {
      filter.mine = !filter.mine;
      b.setAttribute('aria-pressed', filter.mine ? 'true' : 'false');
      reload();
      return;
    }
    if (group === 'sort') {
      if (filter.sort === value) return;
      filter.sort = value;
    } else if (group === 'mode') filter.mode = value;
    else filter.kind = value;
    for (const c of chips) if (c.dataset.group === group) c.setAttribute('aria-pressed', c === b ? 'true' : 'false');
    if (group === 'sort') reload();
    else apply();
  });
  more.addEventListener('click', () => {
    if (next !== null) void load(next);
  });
  void load(null);

  // The account, when there is one: "My replays" appears and the stars it holds are lit.
  void new AccountClient()
    .restore()
    .then(async (s) => {
      if (s === null) return;
      session = s;
      mineChip.classList.remove('rp-hidden');
      try {
        starred = new Set(await fetchMyStars(s.session));
      } catch {
        /* the stars of this visit only */
      }
    })
    .catch(() => undefined)
    .finally(paintStars);
}
