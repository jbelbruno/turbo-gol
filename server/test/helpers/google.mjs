// Google's side of the OAuth callback, for the server tests (sign-in PR 11). The Worker reads Google
// from the id_token of its token answer (OIDC Core 3.1.3.7: it came straight from Google's token
// endpoint over TLS, so no signature is checked), not from a userinfo endpoint. A test's fake token
// endpoint answers with one of these, and the tests never reach Google.
//
//   idToken(claims)            -> header.payload.signature (the signature is a placeholder: it is not checked)
//   googleTokenAnswer(who, o)  -> the token endpoint's JSON: { access_token, id_token, ... }. "who" are the
//                                 claims a test cares about ({ sub, email, email_verified, hd });
//                                 the rest (iss, aud, iat, exp, and the nonce of the last Google start) is
//                                 filled in as Google would; "o" overrides any claim (an auth_time too: the
//                                 Worker must not read it) and "o.strip" lists claims to leave out.
//   watchGoogleStarts(worker)  -> the same Worker, remembering the nonce of the last redirect to Google
//                                 (the id_token must carry it back; a real browser carries it in the URL).
//   googleSeen                 -> { nonce, state, authorize }: the last start's, as the Location says.

/** The GOOGLE_CLIENT_ID of every test environment: the id_token's aud. */
export const GOOGLE_AUD = 'gid';

/** The last redirect to Google: its OpenID Connect nonce, its state parameter and the whole authorize URL. */
export const googleSeen = { nonce: null, state: null, authorize: null };

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** A JWT-shaped id_token. Only the payload is read by the Worker. */
export function idToken(claims) {
  return `${b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })}.${b64(claims)}.${b64('not-a-real-signature')}`;
}

/** The claims Google's token endpoint would sign for "who", with "over" on top and the stripped ones left out. */
export function googleClaims(who = {}, over = {}) {
  const { strip = [], now = Math.floor(Date.now() / 1000), ...rest } = over;
  const claims = { iss: 'https://accounts.google.com', azp: GOOGLE_AUD, aud: GOOGLE_AUD, iat: now, exp: now + 3600, nonce: googleSeen.nonce, ...who, ...rest };
  for (const k of strip) delete claims[k];
  return claims;
}

/** The token endpoint's JSON answer for "who". */
export function googleTokenAnswer(who = {}, over = {}) {
  return {
    access_token: 'fake-google-access-token',
    expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/userinfo.email',
    token_type: 'Bearer',
    id_token: idToken(googleClaims(who, over)),
  };
}

/** The Worker, noting the nonce of every redirect to Google it answers (googleTokenAnswer carries it back). */
export function watchGoogleStarts(worker) {
  return {
    ...worker,
    fetch: async (request, env, ctx) => {
      const res = await worker.fetch(request, env, ctx);
      const loc = res.headers.get('location');
      if (loc !== null && loc.startsWith('https://accounts.google.com/')) {
        const q = new URL(loc).searchParams;
        googleSeen.authorize = loc;
        googleSeen.nonce = q.get('nonce');
        googleSeen.state = q.get('state');
      }
      return res;
    },
  };
}
