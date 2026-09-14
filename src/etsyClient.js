const { refreshTokens } = require('./etsyAuth');
const { saveTokens } = require('./tokenStore');

const API_BASE = 'https://api.etsy.com/v3/application';

function userIdFromAccessToken(accessToken) {
  return accessToken.split('.')[0];
}

async function apiRequest(tokens, keystring, path, options = {}) {
  const doFetch = (accessToken) =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        'x-api-key': keystring,
        Authorization: `Bearer ${accessToken}`,
      },
    });

  let res = await doFetch(tokens.access_token);

  if (res.status === 401 && tokens.refresh_token) {
    const refreshed = await refreshTokens({ keystring, refreshToken: tokens.refresh_token });
    Object.assign(tokens, refreshed);
    saveTokens(tokens);
    res = await doFetch(tokens.access_token);
  }

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Etsy API error: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function getMyShop(tokens, keystring) {
  const userId = userIdFromAccessToken(tokens.access_token);
  const body = await apiRequest(tokens, keystring, `/users/${userId}/shops`);
  return body;
}

async function listShopListings(tokens, keystring, shopId) {
  return apiRequest(tokens, keystring, `/shops/${shopId}/listings/active`);
}

module.exports = { userIdFromAccessToken, getMyShop, listShopListings };
