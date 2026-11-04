// The target of a smoke script (server/test/smoke.mjs, smoke-p2p.mjs, smoke-accounts.mjs,
// hardening.mjs): --api=<base url> or API, never a default. 127.0.0.1:8787 is the port of a
// developer's own `npm run dev` (wrangler.jsonc dev.port): a script started without a target must
// not open requests or sockets there. Tested in server/test/smoke-target.test.mjs.

/** What a script prints, and exits 2 with, when it was given no target. */
export const NO_TARGET = [
  'No target: pass --api=<base url> or set API (for example --api=http://127.0.0.1:8799).',
  'There is no default any more: 127.0.0.1:8787 may be somebody else\'s wrangler dev.',
  'A local run, from server/: npx wrangler dev --port <P> --ip 127.0.0.1 --local-upstream 127.0.0.1:<P> --var DEV_AUTH:1',
  '(without --local-upstream the Worker hands out socket URLs on wrangler.jsonc\'s dev.host, 127.0.0.1:8787),',
  'then: node server/test/<script>.mjs --api=http://127.0.0.1:<P>',
].join('\n');

/**
 * The base URL (no trailing slash) from `argv`'s --api=<url> (it wins) or `env.API`, or { error }
 * when there is none or it is not an http(s) URL. Pure.
 */
export function smokeTarget(argv, env) {
  const flag = argv.find((a) => a.startsWith('--api='));
  const raw = (flag !== undefined ? flag.slice('--api='.length) : (env.API ?? '')).trim();
  if (raw === '') return { error: NO_TARGET };
  if (!/^https?:\/\/[^/\s]/.test(raw)) return { error: `API must be an http(s) URL, got '${raw}'` };
  return { api: raw.replace(/\/+$/, '') };
}

/** This process's target (smokeTarget), or the message on stderr and exit 2: the script cannot run. */
export function smokeApiOrExit() {
  const t = smokeTarget(process.argv.slice(2), process.env);
  if ('error' in t) {
    console.error(t.error);
    process.exit(2);
  }
  return t.api;
}
