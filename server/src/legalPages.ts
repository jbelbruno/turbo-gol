/**
 * The terms of service and the privacy policy as pages (the legal draft's P12): GET or HEAD
 *
 *   /terminos     docs/legal/terminos.es.md    the terms, in Spanish (the official text)
 *   /privacidad   docs/legal/privacidad.es.md  the privacy policy, in Spanish (the official text)
 *   /terms        docs/legal/terms.en.md       the terms' informative English translation
 *   /privacy      docs/legal/privacy.en.md     the privacy policy's informative English translation
 *
 * rendered here from the owner's Markdown as it is (renderMarkdown: headings, paragraphs, lists,
 * quotes, tables, code, bold, italics and links; every other character escaped), only while
 * TERMS_VERSION is set (env.ts termsVersion). Unset, each one answers 404 not_found, the answer of
 * an unknown route, and the game shows no link to them (GET /api/config legal.terms is null).
 * wrangler.jsonc routes the four paths to the Worker first (run_worker_first): the asset layer
 * would answer them with the game's index.html.
 *
 * Each page is one HTML document with its style and its script inline and nothing else: no font,
 * no image, no request. Its own Content-Security-Policy (an answer of the Worker gets nothing from
 * public/_headers) allows that style and that script by their SHA-256 and nothing else of its own;
 * Cloudflare's Web Analytics beacon and email decoder, which the zone may inject, are allowed as
 * public/_headers allows them, so a page shows no CSP violation either way. The other headers are
 * public/_headers' ones.
 *
 * The zone has Email Address Obfuscation on: left alone, Cloudflare would turn every address of the
 * texts into "[email protected]", readable only once its decoder script runs (never in a reader
 * view, a text browser or a page saved as it came). So every address the page shows and every
 * mailto link goes out between <!--email_off--> and <!--/email_off--> (emailOff), the comments
 * Cloudflare leaves the addresses alone between. Comments only: the style, the script and their
 * hashes in the policy stay as they are.
 *
 * PC, phone and TV: one column of at most 46 em, the type 16 px on a phone up to about 27 px on a
 * 1080p TV, tables stacked as cards on a narrow screen (each cell with its column's name: no
 * sideways scroll). Keyboard and remote: Tab and the links as everywhere; ▲ ▼ walk the links in
 * sight and otherwise scroll the page by most of a screen (a remote has no Tab and no wheel); OK or
 * Enter follows the focused link; Back (Escape, Backspace, a TV's Back key) returns to the page
 * before, or to the game. The contents' links jump to each section.
 *
 * The Markdown files are bundled with the Worker (wrangler.jsonc rules: Text), so a page changes
 * with a deploy only; index.ts loads this module only for these paths (node tests that import
 * index.ts never read a .md file).
 *
 * Beside them, in the same shell, style, script, policy and headers, the page that says what
 * Turbogol is (the home page of Google's OAuth consent screen: what Google reads there must be in
 * the HTML, without a script, which the game's index.html is not):
 *
 *   /about        docs/about/about.en.md       what Turbogol is, its sign-in with Google, who offers it
 *   /acerca       docs/about/about.es.md       the same, in Spanish
 *
 * routed and gated as the four (the texts it links to are there only while TERMS_VERSION is set),
 * with no contents, no version and no link to the other legal text: its bar goes to the game and to
 * the other language. Its head adds a description (the text's first paragraph) and its canonical
 * address; no page here asks search engines to skip it.
 */
import type { Env } from './env';
import { error, termsVersion } from './env';
import { SITE_URL } from '../../src/brand';
import terminosEs from '../../docs/legal/terminos.es.md';
import privacidadEs from '../../docs/legal/privacidad.es.md';
import termsEn from '../../docs/legal/terms.en.md';
import privacyEn from '../../docs/legal/privacy.en.md';
import aboutEn from '../../docs/about/about.en.md';
import aboutEs from '../../docs/about/about.es.md';

type Lang = 'es' | 'en';
type Doc = 'terms' | 'privacy';

interface LegalPage {
  path: string;
  lang: Lang;
  doc: Doc;
  source: string;
}

/** The four pages, by path. */
export const LEGAL_PAGES: Readonly<Record<string, LegalPage>> = {
  '/terminos': { path: '/terminos', lang: 'es', doc: 'terms', source: terminosEs },
  '/privacidad': { path: '/privacidad', lang: 'es', doc: 'privacy', source: privacidadEs },
  '/terms': { path: '/terms', lang: 'en', doc: 'terms', source: termsEn },
  '/privacy': { path: '/privacy', lang: 'en', doc: 'privacy', source: privacyEn },
};

/** Where each text is in each language. */
const PATHS: Readonly<Record<Lang, Record<Doc, string>>> = {
  es: { terms: '/terminos', privacy: '/privacidad' },
  en: { terms: '/terms', privacy: '/privacy' },
};

/** The page's own words around the text (the texts themselves are the owner's, untouched). */
const CHROME: Readonly<Record<Lang, { back: string; contents: string; terms: string; privacy: string; other: string; otherLang: Lang; version: string; official: string }>> = {
  es: {
    back: 'Volver al juego',
    contents: 'Contenido',
    terms: 'Términos de uso',
    privacy: 'Política de privacidad',
    other: 'English',
    otherLang: 'en',
    version: 'Versión de los textos: {v}',
    official: 'Este texto en español es el oficial.',
  },
  en: {
    back: 'Back to the game',
    contents: 'Contents',
    terms: 'Terms of use',
    privacy: 'Privacy policy',
    other: 'Español',
    otherLang: 'es',
    version: 'Version of the texts: {v}',
    official: 'This English text is an informative translation: the Spanish one is the official text.',
  },
};

interface AboutPage {
  path: string;
  lang: Lang;
  source: string;
}

/** The about page in each language, by path. */
export const ABOUT_PAGES: Readonly<Record<string, AboutPage>> = {
  '/about': { path: '/about', lang: 'en', source: aboutEn },
  '/acerca': { path: '/acerca', lang: 'es', source: aboutEs },
};

const ABOUT_PATHS: Readonly<Record<Lang, string>> = { es: '/acerca', en: '/about' };

/** The about page's own words around its text. */
const ABOUT_CHROME: Readonly<Record<Lang, { play: string; name: string; other: string; otherLang: Lang }>> = {
  es: { play: 'Jugar', name: 'Acerca de Turbogol', other: 'English', otherLang: 'en' },
  en: { play: 'Play', name: 'About Turbogol', other: 'Español', otherLang: 'es' },
};

// ---- Markdown, the subset the texts use ------------------------------------------------------------

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'hr' }
  | { t: 'quote'; children: Block[] }
  | { t: 'list'; ordered: boolean; start: number; loose: boolean; items: Block[][] }
  | { t: 'table'; head: string[]; rows: string[][] };

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const blank = (l: string): boolean => l.trim() === '';
const indentOf = (l: string): number => l.length - l.replace(/^ +/, '').length;
const tableStart = (lines: readonly string[], i: number): boolean => lines[i].trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);

/** A line that ends a paragraph: another block starts there. */
function interrupts(lines: readonly string[], i: number): boolean {
  const l = lines[i];
  return HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || tableStart(lines, i);
}

/** A table row's cells: split on the pipes outside code (a backslash keeps one), the outer pipes dropped. */
function cells(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let code = false;
  const s = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** The blocks of `lines` (a document, a quote's inside, a list item's inside). */
function parseBlocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    if (HR.test(l)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    const hm = HEADING.exec(l);
    if (hm !== null) {
      out.push({ t: 'h', level: hm[1].length, text: hm[2] });
      i++;
      continue;
    }
    if (QUOTE.test(l)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push((QUOTE.exec(lines[i++]) as RegExpExecArray)[1]);
      out.push({ t: 'quote', children: parseBlocks(inner) });
      continue;
    }
    if (tableStart(lines, i)) {
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const lm = LIST.exec(l);
    if (lm !== null) {
      i = parseList(lines, i, out);
      continue;
    }
    const para: string[] = [l.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i)) para.push(lines[i++].trim());
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

/** One list from line `i` (items of one kind at its indentation), pushed on `out`; the line after it. */
function parseList(lines: readonly string[], start: number, out: Block[]): number {
  const first = LIST.exec(lines[start]) as RegExpExecArray;
  const ordered = /\d/.test(first[2]);
  const base = first[1].length;
  const items: Block[][] = [];
  let loose = false;
  let i = start;
  for (;;) {
    const m = LIST.exec(lines[i]) as RegExpExecArray;
    // The item's content starts after its marker and the spaces after it (one, when the item starts empty).
    const content = m[1].length + m[2].length + Math.max(1, m[3].length);
    const own: string[] = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        let j = i + 1;
        while (j < lines.length && blank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= content) {
          own.push('');
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) >= content) {
        own.push(l.slice(content));
        i++;
        continue;
      }
      // A marker at this list's level or above is the next item, or another list; a block at the margin ends it.
      if (LIST.test(l) || (indentOf(l) === 0 && interrupts(lines, i))) break;
      own.push(l.trim()); // a lazy line of the item's paragraph
      i++;
    }
    items.push(parseBlocks(own));
    let j = i;
    while (j < lines.length && blank(lines[j])) j++;
    const next = j < lines.length ? LIST.exec(lines[j]) : null;
    if (next === null || /\d/.test(next[2]) !== ordered || next[1].length > base + 3) break;
    if (j > i) loose = true;
    i = j;
  }
  out.push({ t: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, loose, items });
  return i;
}

const ESC: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text as HTML: every character that could start markup escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** A link the pages may carry: the web, a mail, a path or an anchor of this site; nothing else (javascript:, data:...). */
function safeUrl(url: string): boolean {
  return /^(?:https?:\/\/[^\s]+|mailto:[^\s]+|\/(?!\/)[^\s]*|#[^\s]*)$/i.test(url);
}

/** The comments Cloudflare's Email Address Obfuscation leaves the addresses alone between. */
export const EMAIL_OFF = '<!--email_off-->';
export const EMAIL_ON = '<!--/email_off-->';

/** An email address as Cloudflare's obfuscation finds one in a page's text (a trailing '.' or ',' is not part of it). */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** HTML kept as it is by Cloudflare's obfuscation (any marker inside dropped: they do not nest). */
function emailOff(html: string): string {
  return EMAIL_OFF + html.replaceAll(EMAIL_OFF, '').replaceAll(EMAIL_ON, '') + EMAIL_ON;
}

/** Text as HTML, escaped, each address in it kept from the obfuscation. */
function textHtml(s: string): string {
  return escapeHtml(s).replace(ADDRESS, (m) => emailOff(m));
}

function anchor(url: string, inner: string): string {
  const external = /^https?:/i.test(url);
  const a = `<a href="${escapeHtml(url)}"${external ? ' rel="noopener noreferrer"' : ''}>${inner}</a>`;
  // A mailto link whole (its href and its words): Cloudflare would rewrite the href too.
  return /^mailto:/i.test(url) ? emailOff(a) : a;
}

/** The index of the `]` that closes the `[` at `open`, or -1. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/** The closing run of `mark` for an emphasis opened at `from` (not after a space), or -1. */
function closeEmphasis(s: string, from: number, mark: string): number {
  for (let k = s.indexOf(mark, from); k !== -1; k = s.indexOf(mark, k + 1)) {
    if (k > from && !/\s/.test(s[k - 1]) && (mark.length === 2 || (s[k + 1] !== '*' && s[k - 1] !== '*'))) return k;
  }
  return -1;
}

/** One paragraph's (or cell's, or heading's) text as inline HTML. */
export function renderInline(s: string): string {
  let out = '';
  // The plain text not written yet: written escaped, its addresses kept from the obfuscation, before any markup.
  let text = '';
  const emit = (html: string): void => {
    out += textHtml(text) + html;
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|<>~]/.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end !== -1) {
        emit(`<code>${textHtml(s.slice(i + n, end).replace(/\n/g, ' '))}</code>`);
        i = end + n;
        continue;
      }
      text += fence;
      i += n;
      continue;
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m !== null) {
        emit(anchor(m[1], textHtml(m[1].replace(/^mailto:/i, ''))));
        i += m[0].length;
        continue;
      }
    }
    if (c === '[') {
      const end = closeBracket(s, i);
      if (end !== -1 && s[end + 1] === '(') {
        const close = s.indexOf(')', end + 2);
        if (close !== -1) {
          const url = s.slice(end + 2, close).trim();
          const inner = renderInline(s.slice(i + 1, end));
          emit(safeUrl(url) ? anchor(url, inner) : inner);
          i = close + 1;
          continue;
        }
      }
    }
    if (c === '*' && i + 1 < s.length && !/\s/.test(s[i + (s[i + 1] === '*' ? 2 : 1)] ?? ' ')) {
      const mark = s[i + 1] === '*' ? '**' : '*';
      const end = closeEmphasis(s, i + mark.length, mark);
      if (end !== -1) {
        const tag = mark === '**' ? 'strong' : 'em';
        emit(`<${tag}>${renderInline(s.slice(i + mark.length, end))}</${tag}>`);
        i = end + mark.length;
        continue;
      }
    }
    text += c;
    i++;
  }
  emit('');
  return out;
}

/** A heading's text as plain words (its id, a cell's label). */
function plain(s: string): string {
  return s
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\\(.)/g, '$1')
    .trim();
}

/** An anchor id from a heading: lower case, without accents, words joined by '-'. */
export function slugOf(s: string): string {
  const slug = plain(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'seccion' : slug;
}

interface Rendered {
  html: string;
  title: string;
  toc: Array<{ id: string; text: string }>;
  /** The first paragraph outside a list or a quote, as plain words on one line (the about page's description). */
  lead: string;
}

/** Markdown as HTML (the subset above), its first heading as the title, every second-level one in the contents and its first paragraph as the lead. */
export function renderMarkdown(md: string): Rendered {
  const blocks = parseBlocks(md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  const ids = new Set<string>();
  const toc: Rendered['toc'] = [];
  let title = '';
  const idFor = (text: string): string => {
    const base = slugOf(text);
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const render = (list: readonly Block[], tight = false): string =>
    list
      .map((b) => {
        switch (b.t) {
          case 'h': {
            const id = idFor(b.text);
            if (b.level === 1 && title === '') title = plain(b.text);
            if (b.level === 2) toc.push({ id, text: plain(b.text) });
            return `<h${b.level} id="${id}">${renderInline(b.text)}</h${b.level}>`;
          }
          case 'p':
            return tight ? renderInline(b.text) : `<p>${renderInline(b.text)}</p>`;
          case 'hr':
            return '<hr>';
          case 'quote':
            return `<blockquote>${render(b.children)}</blockquote>`;
          case 'list': {
            const tag = b.ordered ? 'ol' : 'ul';
            const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
            const items = b.items.map((item) => `<li>${render(item, !b.loose && item.filter((x) => x.t === 'p').length <= 1)}</li>`).join('');
            return `<${tag}${start}>${items}</${tag}>`;
          }
          case 'table': {
            const labels = b.head.map((x) => escapeHtml(plain(x)));
            // A table whose header row is empty (a two-column list of facts) gets none.
            const head = b.head.every((x) => x === '') ? '' : `<thead><tr>${b.head.map((x) => `<th scope="col">${renderInline(x)}</th>`).join('')}</tr></thead>`;
            const rows = b.rows.map((r) => `<tr>${b.head.map((_, k) => `<td data-label="${labels[k]}">${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('');
            return `<div class="tbl"><table>${head}<tbody>${rows}</tbody></table></div>`;
          }
        }
        return '';
      })
      .join('\n');
  const html = render(blocks);
  const first = blocks.find((b) => b.t === 'p');
  const lead = first === undefined ? '' : plain(first.text).replace(/\s+/g, ' ');
  return { html, title, toc, lead };
}

// ---- the page --------------------------------------------------------------------------------------

/** The page's style (its SHA-256 is in the page's CSP). The game's colours (src/ui/styles/tokens.css), its body font stack. */
export const LEGAL_CSS = `
:root{color-scheme:dark;--bg:#0e1117;--card:#161a22;--card2:#1f2430;--edge:#2b313c;--text:#f4f7ff;--text2:#b9c0cc;--link:#c6ff2e;--focus:#fff}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-padding-top:5em}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,-apple-system,Roboto,'Helvetica Neue',Arial,sans-serif;font-size:clamp(16px,0.6rem + 0.9vw,28px);line-height:1.55;overflow-wrap:break-word}
.bar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.4em 1em;padding:.55em max(16px,calc((100vw - 48em)/2));background:var(--bg);border-bottom:1px solid var(--edge)}
.bar nav{display:flex;flex-wrap:wrap;gap:.4em 1em}
main{max-width:46em;margin:0 auto;padding:1.2em 16px 3em}
a{color:var(--link);text-underline-offset:.18em}
a:focus,a:focus-visible{outline:.18em solid var(--focus);outline-offset:.15em;border-radius:.2em}
a:focus:not(:focus-visible){outline-color:var(--link)}
.bar a{display:inline-block;padding:.35em .1em;font-weight:600}
h1{font-size:1.75em;line-height:1.2;margin:.4em 0 .6em}
h2{font-size:1.3em;line-height:1.25;margin:1.6em 0 .5em}
h3{font-size:1.1em;margin:1.5em 0 .4em}
h4,h5,h6{font-size:1em;margin:1.2em 0 .3em}
p,ul,ol,blockquote,.tbl{margin:.6em 0}
ul,ol{padding-left:1.4em}
li{margin:.3em 0}
li>ul,li>ol{margin:.3em 0}
blockquote{margin-left:0;margin-right:0;padding:.6em 1em;background:var(--card);border-left:.25em solid var(--edge);color:var(--text2)}
code{font-family:ui-monospace,Consolas,'Cascadia Mono',Menlo,monospace;font-size:.88em;background:var(--card2);padding:.05em .3em;border-radius:.25em;overflow-wrap:anywhere}
hr{border:0;border-top:1px solid var(--edge);margin:1.6em 0}
table{width:100%;border-collapse:collapse;font-size:.92em}
th,td{text-align:left;vertical-align:top;padding:.45em .6em;border:1px solid var(--edge);overflow-wrap:anywhere}
th{background:var(--card2)}
td{background:var(--card)}
.toc{background:var(--card);border:1px solid var(--edge);border-radius:.5em;padding:.6em 1em;margin:1em 0 1.4em}
.toc h2{font-size:1em;margin:0 0 .3em}
.toc ul{margin:0;padding:0;list-style:none}
.toc li{margin:.15em 0}
.toc a{display:inline-block;padding:.1em 0}
footer{max-width:46em;margin:0 auto;padding:1em 16px 3em;color:var(--text2);border-top:1px solid var(--edge)}
footer p{margin:.3em 0}
@media (max-width:600px){
  .tbl table,.tbl thead,.tbl tbody,.tbl tr,.tbl th,.tbl td{display:block;width:auto}
  .tbl thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .tbl tr{margin:0 0 .6em;border:1px solid var(--edge);border-radius:.4em;overflow:hidden}
  .tbl td{border:0;border-top:1px solid var(--edge)}
  .tbl td:first-child{border-top:0}
  .tbl td::before{content:attr(data-label);display:block;font-size:.8em;font-weight:600;color:var(--text2)}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`.trim();

/**
 * The page's script (its SHA-256 is in the page's CSP): a remote's arrows and Back. ▲ ▼ focus the
 * next link that way within sight, else scroll most of a screen; Back (Escape, Backspace outside a
 * field, Tizen's 10009, webOS's 461, the browser's Back key) goes back, or to the game.
 */
export const LEGAL_JS = `
(function(){
  var links=function(){return Array.prototype.slice.call(document.querySelectorAll('a[href]'));};
  var top=function(el){return el.getBoundingClientRect().top;};
  function move(dir){
    var vh=window.innerHeight,all=links(),cur=document.activeElement,from;
    if(cur&&all.indexOf(cur)>=0&&top(cur)>-vh*0.1&&top(cur)<vh*1.1)from=top(cur);else from=dir>0?-1:vh+1;
    var pick=null,i;
    if(dir>0){for(i=0;i<all.length;i++){var t=top(all[i]);if(t>from+1&&t<vh*0.92&&all[i].offsetParent!==null){pick=all[i];break;}}}
    else{for(i=all.length-1;i>=0;i--){var u=top(all[i]);if(u<from-1&&u>vh*0.08&&all[i].offsetParent!==null){pick=all[i];break;}}}
    if(pick){pick.focus();return;}
    window.scrollBy(0,dir*Math.round(vh*0.6));
  }
  function back(){
    if(window.history.length>1&&document.referrer.indexOf(location.origin+'/')===0)window.history.back();else location.href='/';
  }
  document.addEventListener('keydown',function(e){
    if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey)return;
    var k=e.key,c=e.keyCode,t=e.target,field=t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if(field)return;
    if(k==='ArrowDown'||k==='Down'||c===40){e.preventDefault();move(1);}
    else if(k==='ArrowUp'||k==='Up'||c===38){e.preventDefault();move(-1);}
    else if(k==='Escape'||k==='Esc'||k==='Backspace'||k==='GoBack'||k==='BrowserBack'||c===10009||c===461){e.preventDefault();back();}
  });
})();
`.trim();

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The page's policy: its own style and script by hash and nothing else of its own (no fetch, no
 * frame, no form, no base); the beacon and email decoder the zone may inject as public/_headers
 * allows them ('self' and static.cloudflareinsights.com, its reports to /cdn-cgi/rum).
 */
export async function legalCsp(): Promise<string> {
  const [style, script] = await Promise.all([sha256Base64(LEGAL_CSS), sha256Base64(LEGAL_JS)]);
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${script}' https://static.cloudflareinsights.com`,
    "script-src-attr 'none'",
    `style-src 'sha256-${style}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** The whole document of one page (`version`: TERMS_VERSION, shown under the text). */
export function legalDocument(page: LegalPage, version: string): string {
  const w = CHROME[page.lang];
  const other = CHROME[w.otherLang];
  const r = renderMarkdown(page.source);
  const sibling: Doc = page.doc === 'terms' ? 'privacy' : 'terms';
  const toc = r.toc.length > 0 ? `<nav class="toc" aria-labelledby="toc-h"><h2 id="toc-h">${escapeHtml(w.contents)}</h2><ul>${r.toc.map((x) => `<li><a href="#${x.id}">${textHtml(x.text)}</a></li>`).join('')}</ul></nav>` : '';
  // The contents go right after the title (the first heading).
  const body = r.html.replace(/(<h1 [^>]*>[\s\S]*?<\/h1>)/, `$1\n${toc}`);
  const title = r.title !== '' ? r.title : page.doc === 'terms' ? w.terms : w.privacy;
  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0e1117">
<title>${escapeHtml(title)}</title>
<link rel="alternate" hreflang="${w.otherLang}" href="${PATHS[w.otherLang][page.doc]}">
<style>${LEGAL_CSS}</style>
</head>
<body>
<header class="bar"><a href="/">${escapeHtml(w.back)}</a><nav aria-label="${escapeHtml(title)}"><a href="${PATHS[page.lang][sibling]}">${escapeHtml(sibling === 'terms' ? w.terms : w.privacy)}</a><a href="${PATHS[w.otherLang][page.doc]}" hreflang="${w.otherLang}" lang="${w.otherLang}">${escapeHtml(w.other)}</a></nav></header>
<main id="texto">
${body}
</main>
<footer><p>${escapeHtml(w.version.replace('{v}', version))}</p><p>${escapeHtml(w.official)}</p><p><a href="${PATHS[w.otherLang][page.doc]}" hreflang="${w.otherLang}" lang="${w.otherLang}">${escapeHtml(page.doc === 'terms' ? other.terms : other.privacy)} (${escapeHtml(w.other)})</a></p></footer>
<script>${LEGAL_JS}</script>
</body>
</html>
`;
}

/**
 * The whole document of an about page: the legal pages' shell with the way to the game and the
 * other language in its bar, no contents and no version; its description and its canonical address
 * (and the other language's) in its head, for the readers that index it.
 */
export function aboutDocument(page: AboutPage): string {
  const w = ABOUT_CHROME[page.lang];
  const other = ABOUT_CHROME[w.otherLang];
  const r = renderMarkdown(page.source);
  const title = r.title !== '' ? r.title : w.name;
  const otherPath = ABOUT_PATHS[w.otherLang];
  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0e1117">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(r.lead)}">
<link rel="canonical" href="${SITE_URL}${page.path}">
<link rel="alternate" hreflang="${page.lang}" href="${SITE_URL}${page.path}">
<link rel="alternate" hreflang="${w.otherLang}" href="${SITE_URL}${otherPath}">
<style>${LEGAL_CSS}</style>
</head>
<body>
<header class="bar"><a href="/">${escapeHtml(w.play)}</a><nav aria-label="${escapeHtml(w.name)}"><a href="${otherPath}" hreflang="${w.otherLang}" lang="${w.otherLang}">${escapeHtml(w.other)}</a></nav></header>
<main id="texto">
${r.html}
</main>
<footer><p><a href="${otherPath}" hreflang="${w.otherLang}" lang="${w.otherLang}">${escapeHtml(other.name)} (${escapeHtml(w.other)})</a></p></footer>
<script>${LEGAL_JS}</script>
</body>
</html>
`;
}

/** The headers public/_headers gives the game's pages, and this page's own policy. */
function pageHeaders(csp: string, extra: Record<string, string>): Headers {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    ...extra,
  });
}

/** Rendered pages per isolate, by path and version (a new version is a new deploy or a new var). */
const cache = new Map<string, { html: string; csp: string; etag: string }>();

/** One of the four paths (index.ts routes them here, GET or HEAD or not). */
export function isLegalPath(path: string): boolean {
  return Object.hasOwn(LEGAL_PAGES, path);
}

/**
 * GET or HEAD of a legal page or an about page: the page while TERMS_VERSION is set, else 404
 * not_found (no-store, so the owner's publish shows at once); any other method 404 as well. Cached
 * 5 minutes by browsers, revalidated by its ETag (the version and the text's hash).
 */
export async function legalPage(request: Request, env: Pick<Env, 'TERMS_VERSION'>): Promise<Response> {
  const path = new URL(request.url).pathname;
  const page: LegalPage | AboutPage | undefined = LEGAL_PAGES[path] ?? ABOUT_PAGES[path];
  const version = termsVersion(env);
  const head = request.method === 'HEAD';
  if (page === undefined || version === null || (request.method !== 'GET' && !head)) {
    const res = error(404, 'not_found');
    res.headers.set('cache-control', 'no-store');
    return res;
  }
  const key = path + '\n' + version;
  let hit = cache.get(key);
  if (hit === undefined) {
    const html = 'doc' in page ? legalDocument(page, version) : aboutDocument(page);
    hit = { html, csp: await legalCsp(), etag: `"${(await sha256Base64(html)).slice(0, 27)}"` };
    cache.set(key, hit);
  }
  const headers = pageHeaders(hit.csp, { 'cache-control': 'public, max-age=300', etag: hit.etag, 'content-language': page.lang, vary: 'Accept-Encoding' });
  if (request.headers.get('if-none-match') === hit.etag) return new Response(null, { status: 304, headers });
  return new Response(head ? null : hit.html, { status: 200, headers });
}
