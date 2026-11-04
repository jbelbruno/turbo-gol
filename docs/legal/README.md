# The legal texts

The terms of service and the privacy policy of turbo-gol.com, as the game serves them:

| File | Page | What it is |
|---|---|---|
| `terminos.es.md` | `/terminos` | The terms of service, in Spanish: the official text |
| `privacidad.es.md` | `/privacidad` | The privacy policy, in Spanish: the official text |
| `terms.en.md` | `/terms` | The terms' informative English translation |
| `privacy.en.md` | `/privacy` | The privacy policy's informative English translation |

**Version `2026-11-04`, in force from 4 November 2026,** approved by the owner on 3 November 2026.
The Spanish texts are the official ones; the English ones are informative translations. They were
checked against the code of this release, sentence by sentence, and reviewed independently. They
are not legal advice, and a lawyer has not reviewed them yet. The code never edits them: the Worker
renders them as they are.

**Changing a text** means changing it in both languages, giving it a new version in its header and
in `TERMS_VERSION`, in the same deploy, and announcing it 30 days ahead when it is an important
change (Términos 18). Nothing checks that a `[[TOKEN]]` was left in a text: search for `[[` before
publishing.

## How they reach the players

The switch is one Worker var, `TERMS_VERSION` in `server/wrangler.jsonc` (`2026-11-04`):

- **Empty or unset:** `/terminos`, `/privacidad`, `/terms` and `/privacy` answer 404, as an unknown
  route. `GET /api/config` says `legal.terms: null`, and the game shows no notice, no link and no
  acceptance. A sign-up records no terms.
- **Set** (lower-case letters, digits, `.`, `_` and `-`, at most 32, e.g. `2026-12-01`):
  - the four pages are served (`server/src/legalPages.ts`), with the version under the text;
  - the About sheet (every screen's footer) and PERFIL's ACERCA DE link to them;
  - a short notice with both links sits right above the buttons that accept: JUGAR COMO INVITADO,
    CREAR CUENTA, and the OAuth confirm step's NO, CREAR MI CUENTA;
  - before a guest's first online match, a sheet asks with that notice and JUGAR COMO INVITADO. The
    accepted version is kept in that browser (`localStorage` `turbogol.terms`);
  - an account's acceptance is a `consents` row of kind `terms` with the version (source `signup`,
    `oauth_signup`, or `reaccept`);
  - a new value is a new version: every account that has not accepted it gets a sheet to accept it
    before it plays online again, and every guest gets the guest sheet again.

The texts are bundled with the Worker (a deploy changes them). Publish a new text and its version
in the same deploy.

Account deletion has its own switch, `DELETION_OPEN` (`"1"` since this version). Set to `"1"`, PERFIL shows
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
