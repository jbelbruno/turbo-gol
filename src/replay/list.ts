/**
 * The replay list (replay.html without ?id): the matches the community servers played in the
 * last 30 days (src/net/replays.ts), newest hour first, a page at a time; each shows the hour it
 * ended in (the server rounds it), never the minute. A scoreboard card per match (blue side, the
 * score, red side; the winner lit), filters by kind and format over what is loaded. Every text
 * goes in as textContent: names come from players (a hidden one, 'Jugador N', in this page's
 * language: names.ts).
 */
import { t } from '../i18n';
import type { Key } from '../i18n';
import { PROTOCOL_VERSION } from '../net/protocol';
import { fetchReplayList } from '../net/replays';
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

/** One match as a scoreboard card (the whole card is the link to watch it). */
function card(m: ReplayListItem): HTMLElement {
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
  return el(
    'a.rp-card',
    { href: `?id=${m.matchId}`, 'data-kind': m.ranked ? 'ranked' : 'casual', 'data-mode': m.mode },
    el('div.rp-bar'),
    el('div.rp-board', null, side(0), score, side(1)),
    el('div.rp-foot', null, el('div.rp-meta', null, el('span', null, when), m.ticks > 0 ? el('span', null, clockText(m.ticks)) : null, ...chips), el('span.rp-go', null, el('span.rp-tri'), t('replay.watch'))),
  );
}

const skeletons = (rows: HTMLElement): void => {
  for (let i = 0; i < 3; i++) rows.append(el('div.rp-skel', { 'aria-hidden': 'true' }));
};

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

  // Filters (over what is loaded): kind and format, one pick each.
  const filter = { kind: 'all', mode: 'all' };
  const chipOf = (group: 'kind' | 'mode', value: string, text: string): HTMLButtonElement =>
    el('button.rp-fchip', { type: 'button', 'aria-pressed': value === 'all' ? 'true' : 'false', 'data-group': group, 'data-value': value }, text) as HTMLButtonElement;
  const chips: HTMLButtonElement[] = [
    chipOf('kind', 'all', t('replay.all')),
    chipOf('kind', 'ranked', t('replay.ranked')),
    chipOf('kind', 'casual', t('replay.casual')),
    chipOf('mode', 'all', t('replay.anyFormat')),
    chipOf('mode', '1v1', '1v1'),
    chipOf('mode', '2v2', '2v2'),
    chipOf('mode', '3v3', '3v3'),
  ];
  const filtersEl = el('div.rp-filters', null, el('div.rp-fgroup', null, ...chips.slice(0, 3)), el('div.rp-fgroup', null, ...chips.slice(3)));
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
  filtersEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.rp-fchip');
    if (!b) return;
    const group = b.dataset.group === 'mode' ? 'mode' : 'kind';
    filter[group] = b.dataset.value ?? 'all';
    for (const c of chips) if (c.dataset.group === group) c.setAttribute('aria-pressed', c === b ? 'true' : 'false');
    apply();
  });

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
  const clearSkeletons = (): void => {
    for (const s of rows.querySelectorAll('.rp-skel')) s.remove();
  };
  const load = async (before: string | null): Promise<void> => {
    if (busy) return;
    busy = true;
    more.setAttribute('disabled', '');
    try {
      const page = await fetchReplayList(before);
      clearSkeletons();
      for (const m of page.matches) rows.append(card(m));
      next = page.next;
      apply();
      note.classList.toggle('rp-hidden', rows.childElementCount > 0);
      note.textContent = t('replay.empty');
    } catch (e) {
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
      busy = false;
      more.removeAttribute('disabled');
      moreLine.classList.toggle('rp-hidden', next === null);
    }
  };
  more.addEventListener('click', () => {
    if (next !== null) void load(next);
  });
  void load(null);
}
