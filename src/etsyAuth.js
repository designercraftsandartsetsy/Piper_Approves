const { generateVerifier, challengeFromVerifier, generateState } = require('./pkce');

const AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

// In-memory store of pending PKCE verifiers keyed by state.
// Fine for a single-user local dev server; not for a multi-user deployment.
const pendingStates = new Map();

function buildAuthorizeUrl({ keystring, redirectUri, scopes }) {
  const verifier = generateVerifier();
  const state = generateState();
  pendingStates.set(state, verifier);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', keystring);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFromVerifier(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}

function takeVerifierForState(state) {
  const verifier = pendingStates.get(state);
  pendingStates.delete(state);
  return verifier;
}

async function exchangeCodeForTokens({ keystring, redirectUri, code, verifier }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: keystring,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Etsy token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body; // { access_token, refresh_token, expires_in, token_type }
}

async function refreshTokens({ keystring, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: keystring,
      refresh_token: refreshToken,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Etsy token refresh failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

module.exports = { buildAuthorizeUrl, takeVerifierForState, exchangeCodeForTokens, refreshTokens };
