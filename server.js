require('dotenv').config();
const express = require('express');
const { buildAuthorizeUrl, takeVerifierForState, exchangeCodeForTokens } = require('./src/etsyAuth');
const { saveTokens, loadTokens } = require('./src/tokenStore');
const { getMyShop, listShopListings } = require('./src/etsyClient');

const { ETSY_KEYSTRING, ETSY_REDIRECT_URI, ETSY_SCOPES, PORT = 3000 } = process.env;

if (!ETSY_KEYSTRING || !ETSY_REDIRECT_URI) {
  console.error('Missing ETSY_KEYSTRING or ETSY_REDIRECT_URI. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();

app.get('/', (req, res) => {
  const tokens = loadTokens();
  if (tokens) {
    res.send('<p>Connected to Etsy.</p><p><a href="/listings">View my listings</a></p>');
  } else {
    res.send('<p><a href="/login">Connect to Etsy</a></p>');
  }
});

app.get('/login', (req, res) => {
  const url = buildAuthorizeUrl({
    keystring: ETSY_KEYSTRING,
    redirectUri: ETSY_REDIRECT_URI,
    scopes: ETSY_SCOPES,
  });
  res.redirect(url);
});

app.get('/etsy-callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(400).send(`<p>Etsy authorization failed: ${error} - ${errorDescription || ''}</p>`);
  }

  const verifier = takeVerifierForState(state);
  if (!verifier) {
    return res.status(400).send('<p>Unknown or expired state. Try <a href="/login">connecting again</a>.</p>');
  }

  try {
    const tokens = await exchangeCodeForTokens({
      keystring: ETSY_KEYSTRING,
      redirectUri: ETSY_REDIRECT_URI,
      code,
      verifier,
    });
    saveTokens(tokens);
    res.send('<p>Connected to Etsy successfully.</p><p><a href="/listings">View my listings</a></p>');
  } catch (err) {
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
});

app.get('/listings', async (req, res) => {
  const tokens = loadTokens();
  if (!tokens) {
    return res.redirect('/login');
  }

  try {
    const shopsBody = await getMyShop(tokens, ETSY_KEYSTRING);
    const shop = shopsBody.results && shopsBody.results[0];
    if (!shop) {
      return res.send('<p>No shop found for this Etsy account.</p>');
    }

    const listingsBody = await listShopListings(tokens, ETSY_KEYSTRING, shop.shop_id);
    const items = (listingsBody.results || [])
      .map((l) => `<li>${l.title} (listing_id: ${l.listing_id})</li>`)
      .join('');
    res.send(`<h2>${shop.shop_name}</h2><ul>${items}</ul>`);
  } catch (err) {
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`Piper Approves dev server running at http://localhost:${PORT}`);
  console.log(`Etsy redirect URI configured as: ${ETSY_REDIRECT_URI}`);
});
