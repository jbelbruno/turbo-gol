# The legal texts

The terms of service and the privacy policy of turbo-gol.com, as the game serves them:

| File | Page | What it is |
|---|---|---|
| `terminos.es.md` | `/terminos` | The terms of service, in Spanish: the official text |
| `privacidad.es.md` | `/privacidad` | The privacy policy, in Spanish: the official text |
| `terms.en.md` | `/terms` | The terms' informative English translation |
| `privacy.en.md` | `/privacy` | The privacy policy's informative English translation |

Next to them, in the same shell and under the same switch, the Worker serves `/about` and `/acerca`
(`docs/about/about.en.md` and `docs/about/about.es.md`, outside this folder because they are not
legal texts): what Turbogol is, what its sign-in with Google asks for and why, and who offers it.
`/about` is the home page of Google's OAuth consent screen, so it must stay readable without a
script and link to `https://turbo-gol.com/privacy`. When the policy changes what it says about
Google sign-in, they change in the same deploy (`server/test/about-page.test.mjs` checks the
scopes).

**Version `2026-11-05`, in force from 5 November 2026, the day of its deploy,** approved by the
owner before its merge. The Spanish texts are the official ones; the English ones are informative
translations. Version `2026-11-05` was checked, sentence by sentence, against the code of the
regional placement (PR #103), the nodes panel's server side (PR #104), the public list of servers
(`feat/nodes-public-list`), the maintainers' history of the servers (`feat/nodes-history`) and the
bots' level (PRs #107 and #108). It names the project's servers in Brazil, Germany and Malaysia
(Hostinger) and, for now, in South Africa, Australia and the United States (Google Cloud). They are
not legal advice, and a lawyer has not reviewed them yet. The code never edits them: the Worker
renders them as they are.

**Changing a text** means changing it in both languages, giving it a new version in its header and
in `TERMS_VERSION`, in the same deploy, and announcing it 7 days ahead when it is an important
change (Términos 18.2; it said 30 days before version `2026-11-05`). Versions `2026-11-04-2` and
`2026-11-05` skipped that notice, by the owner's decisions of 4 November 2026: each was announced
the day it took effect, in the repository (in Spanish, the official text) and on Discord (in
English, below), and every account and guest accepted it again before playing online. Nothing
checks that a `[[TOKEN]]` was left in a text: search for `[[` before publishing.

## The notices of a change

Every notice of a change (Términos 18.2) is two files in `avisos/`, named after the version:

| File | What it is |
|---|---|
| `avisos/2026-11-04-2.md` | The notice of version `2026-11-04-2` (4 November 2026), in Spanish: the official text |
| `avisos/2026-11-04-2.en.md` | Its English translation: the text posted on Discord |
| `avisos/2026-11-05.md` | The notice of version `2026-11-05` (5 November 2026), in Spanish: the official text |
| `avisos/2026-11-05.en.md` | Its English translation: the text posted on Discord |

**Discord in English, the official text in the repository.** The Discord server is English-only,
so the post on Discord is the English translation, `<version>.en.md`, and only that. The official
notice is the Spanish file in the repository, `<version>.md`, as the Spanish texts are the official
ones.

Términos 18.2 says so since version `2026-11-05`: the notice goes, with the new text and the date
from which it applies, to the repository, in Spanish, which is the official text, and its English
translation to the Discord server. Before that version, 18.2 said "en español" for both places;
the notice of 4 November 2026 (version `2026-11-04-2`) was posted on Discord in English only, by
the owner's decision of that day.

On the day the notice is posted (7 days ahead, or the deploy day when a change skips that):

1. Write `avisos/<version>.md`, the official notice in Spanish, and `avisos/<version>.en.md`, its
   English translation. Both have an H1, a short preface, then `## Mensaje 1` and `## Mensaje 2`
   (`## Message 1` and `## Message 2` in English). The Spanish preface says it is the official
   text and links to its English translation, the Discord post; the English one links to the
   official text; both say who posts it and how, as step 4 does.
2. Each bullet and each paragraph is one line, because Discord shows every line break. Each
   message is under 2,000 characters (a message without Nitro), names the version, has no
   headings and gives no address but privacy@turbo-gol.com. Links go between `<` and `>`, so
   Discord does not unfurl them. The English message 2 says the Spanish texts are the official
   ones. `tests/legal-terms.test.mjs` checks both files and their prefaces, and that the
   translation has the same paragraphs, bullets, bold leads, numbers and links as the Spanish
   notice.
3. Merge both before posting, so message 2's link to the full texts already shows them.
4. Post the English translation in the server's announcements channel: the maintainer posts it,
   by hand from Raw or with the project's Discord bot, the text of "Message 1", then that of
   "Message 2", as they are (on GitHub, Raw shows the file as plain text).

## How they reach the players

The switch is one Worker var, `TERMS_VERSION` in `server/wrangler.jsonc` (`2026-11-05`):

- **Empty or unset:** `/terminos`, `/privacidad`, `/terms` and `/privacy` (and `/about` and
  `/acerca`) answer 404, as an unknown route. `GET /api/config` says `legal.terms: null`, and the
  game shows no notice, no link and no acceptance. A sign-up records no terms.
- **Set** (lower-case letters, digits, `.`, `_` and `-`, at most 32, e.g. `2026-12-01`):
  - the four pages are served (`server/src/legalPages.ts`), with the version under the text, and
    so is the about page, without it;
  - the About sheet (every screen's footer) and PERFIL's ACERCA DE link to them;
  - a short notice with both links sits right above the buttons that accept: JUGAR COMO INVITADO,
    CREAR CUENTA, and the OAuth confirm step's NO, CREAR MI CUENTA;
  - before a guest's first online match, a sheet asks with that notice and JUGAR COMO INVITADO. The
    accepted version is kept in that browser (`localStorage` `turbogol.terms`);
  - an account's acceptance is a `consents` row of kind `terms` with the version (source `signup`,
    `oauth_signup`, or `reaccept`);
  - a new value is a new version: every account that has not accepted it gets a sheet to accept it
    before it plays online again, and every guest gets the guest sheet again;
  - once the terms describe hosting (`NODE_HOSTING_TERMS`), a new value also makes every host
    outside the project accept the rules for hosts again (VOLVER A ACEPTAR in MIS SERVIDORES, Terms
    12.2), and until it does none of its servers gets a new match (`server/src/hostPolicy.ts`
    `hostRulesVersion`). Every community server drops out of placement at once, even for a small
    correction: tell the hosts before the deploy.

The texts are bundled with the Worker (a deploy changes them). Publish a new text and its version
in the same deploy.

Account deletion has its own switch, `DELETION_OPEN` (`"1"` since version `2026-11-04`). Set to `"1"`, PERFIL shows
BORRAR CUENTA, the sheet that offers to keep an account whose deletion is pending, and the sheet of
the deletion mail's cancel link (`/account#keep=`). Set it back to `"0"` only when no deletion is
pending: those sheets close with it, although the server keeps the way back open.

## Deleting an account on request

A request by mail (the privacy policy, §12.1) is answered with `POST /api/admin/account-delete`.
The account is deleted at once, with no 14 days to cancel, also when it is suspended or has no
email. Its sanction marks are kept, as for every deletion. The answer is a deletion certificate to
send back within 72 hours. It holds a reference, the dates and a digest, and nothing personal.

Only a maintainer account (`NODE_TRUSTED_OPERATORS`) can call it. The call must come from its own
session, not a TV's, and its device must have typed the password in the last 15 minutes: PERFIL's
CONFIRMAR CON LA CONTRASEÑA, or a fresh sign-in. From the browser's console on turbo-gol.com:

```js
// account: its username (or its id); confirm: its username, typed again; receivedAt: the request's date
const c = await __game.accounts.adminDeleteAccount('TheirName', 'TheirName', '2026-12-03');
console.log(c.text.es); // paste it into the answer (c.text.en in English)
```

The digest is the SHA-256 of `turbogol-deletion-v1`, the reference, the account id and the
deletion time (ms), each on its own line (`server/src/AccountsDO.ts` `deletionDigest`). The account
id stays in `deleted_ids`, so the owner can show which account a certificate is for.
