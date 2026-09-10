// Cloudflare Worker: Etsy shop control plane for DesignerTeesAndHome.
//
// This Worker is the only thing in this project allowed to talk to Etsy's API.
// It also serves a small same-origin dashboard (GET /) so shop changes can be
// reviewed and applied from a regular browser, since the coding sandbox that
// authored this code has no route to the open internet at all.
//
// Write/read API endpoints (everything except "/", "/oauth/callback" and
// "/oauth/exchange") require `X-Worker-Auth: <WORKER_AUTH_TOKEN>`.

const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const ETSY_OAUTH_SCOPE = "listings_r listings_w listings_d shops_r shops_w";
const TOKENS_KEY = "tokens";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function requireWorkerAuth(request, env) {
  const header = request.headers.get("X-Worker-Auth");
  return header && header === env.WORKER_AUTH_TOKEN;
}

async function getTokens(env) {
  const raw = await env.ETSY_STORE.get(TOKENS_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function saveTokens(env, tokens) {
  await env.ETSY_STORE.put(TOKENS_KEY, JSON.stringify(tokens));
}

async function exchangeCodeForTokens(env, code, codeVerifier, redirectUri) {
  const resp = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ETSY_CLIENT_ID,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Etsy token exchange failed: ${JSON.stringify(data)}`);
  return data;
}

async function refreshTokens(env, refreshToken) {
  const resp = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ETSY_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Etsy token refresh failed: ${JSON.stringify(data)}`);
  return data;
}

async function getValidAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens) throw new Error("Not authorized yet — connect to Etsy from the dashboard first.");

  if (Date.now() < tokens.expires_at - 60_000) {
    return tokens;
  }

  const fresh = await refreshTokens(env, tokens.refresh_token);
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + fresh.expires_in * 1000,
  };
  await saveTokens(env, updated);
  return updated;
}

async function etsyFetch(env, path, options = {}) {
  const tokens = await getValidAccessToken(env);
  const resp = await fetch(`${ETSY_API_BASE}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "x-api-key": env.ETSY_CLIENT_ID,
      authorization: `Bearer ${tokens.access_token}`,
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Etsy API ${path} failed (${resp.status}): ${JSON.stringify(data)}`);
  return data;
}

async function handleOauthExchange(request, env) {
  const { code, code_verifier, redirect_uri } = await request.json();
  if (!code || !code_verifier || !redirect_uri) {
    return json({ error: "code, code_verifier and redirect_uri are required" }, 400);
  }

  const tokenData = await exchangeCodeForTokens(env, code, code_verifier, redirect_uri);
  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };
  await saveTokens(env, tokens);

  // Resolve the shop id once, up front, so every later call already knows it.
  const me = await etsyFetch(env, "/users/me");
  const shops = await etsyFetch(env, `/users/${me.user_id}/shops`);
  tokens.user_id = me.user_id;
  tokens.shop_id = shops.shop_id;
  await saveTokens(env, tokens);

  return json({ ok: true, shop_id: shops.shop_id, shop_name: shops.shop_name });
}

async function handleStatus(env) {
  const tokens = await getTokens(env);
  if (!tokens) return json({ authorized: false });
  return json({
    authorized: true,
    shop_id: tokens.shop_id,
    expires_at: new Date(tokens.expires_at).toISOString(),
  });
}

function dashboardHtml(origin, clientId) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Designer Tees and Home — Etsy control panel</title>
<style>
  body { font: 15px/1.5 -apple-system, sans-serif; max-width: 820px; margin: 40px auto; padding: 0 20px; color: #221A1F; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 40px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  button { cursor: pointer; padding: 8px 14px; border: 1px solid #7A3B5E; background: #7A3B5E; color: #fff; border-radius: 4px; font-size: 14px; }
  button.secondary { background: #fff; color: #7A3B5E; }
  button:disabled { opacity: .5; cursor: default; }
  textarea, input[type=text] { width: 100%; font-family: ui-monospace, monospace; font-size: 13px; padding: 6px; box-sizing: border-box; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin: 14px 0; }
  .row { display: flex; gap: 10px; align-items: center; margin: 8px 0; }
  .muted { color: #777; font-size: 13px; }
  .status { padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
  .ok { background: #e6ede2; color: #4F6B45; }
  .bad { background: #f6e2e0; color: #9E3B36; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 8px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>Designer Tees and Home — Etsy control panel</h1>

<div class="card">
  <div class="row">
    <span>Worker auth token:</span>
    <input type="text" id="authToken" placeholder="paste WORKER_AUTH_TOKEN, saved locally in this browser only">
    <button onclick="saveToken()">Save</button>
  </div>
  <div class="row"><span id="statusLine" class="muted">checking status…</span></div>
  <button onclick="connectEtsy()">Connect / reconnect to Etsy</button>
</div>

<h2>Apply audit fixes</h2>
<div id="fixes"><p class="muted">Enter your worker auth token above, then click "Load listings" to match them against the audit's recommended rewrites.</p></div>
<button class="secondary" onclick="loadFixes()">Load listings</button>

<h2>Shop title</h2>
<div id="shopTitleCard" class="card muted">Load listings first.</div>

<script>
const ORIGIN = ${JSON.stringify(origin)};
const CLIENT_ID = ${JSON.stringify(clientId)};
const SCOPE = ${JSON.stringify(ETSY_OAUTH_SCOPE)};

const FIXES = [
  { match: "Yarn Lover Vacation", newTitle: "Crochet Lover Shirt, Gift for Crocheter, Funny Yarn T-Shirt, Crochet Vacation Tee, Crafter Gift for Mom, Yarn Lover Shirt for Women",
    newTags: ["crochet lover shirt","gift for crocheter","yarn lover gift","funny crochet shirt","crochet t shirt","crafter gift","yarn lover shirt","crochet gifts for her","crochet mom shirt","knitting lover tee","gift for crafter","yarn addict shirt","crochet vacation tee"] },
  { match: "Crochet Wall Art", newTitle: "Crochet Wall Art Print, Gift for Crocheter, Yarn Lover Decor, Craft Room Wall Art, Framed Canvas, Crochet Gifts for Her, Botanical Print",
    newTags: ["crochet lover shirt","gift for crocheter","yarn lover gift","craft room wall art","crochet wall art","crafter gift","yarn lover shirt","crochet gifts for her","crochet home decor","knitting lover gift","gift for crafter","yarn addict gift","botanical print"] },
  { match: "Tabby Cats Reading", newTitle: "Crochet Cat Shirt, Gift for Crocheter, Cats Reading Books Tee, Funny Yarn Lover T-Shirt, Cat Mom Crafter Gift, Whimsical Kitten Shirt",
    newTags: ["crochet lover shirt","gift for crocheter","yarn lover gift","funny crochet shirt","cat mom shirt","crafter gift","yarn lover shirt","crochet gifts for her","cats reading books","knitting lover tee","gift for crafter","whimsical kitten tee","crochet cat lover"] },
  { match: "70", newTitle: "Crochet Gift Candle, Soy Candle for Crafters, Yarn Lover Gift, Hand Poured Scented Candle, Craft Room Decor, Gift for Crocheter",
    newTags: ["crochet gift candle","gift for crocheter","yarn lover gift","soy candle gift","crafter gift candle","craft room decor","yarn lover shirt".replace("shirt","candle"),"crochet gifts for her","hand poured candle","knitting lover gift","gift for crafter","scented soy candle","candle for crafters"] },
];

const NEW_SHOP_TITLE = "Crochet Lover Gifts, Yarn Lover Shirts & Craft Room Decor";

function authHeaders() {
  return { "X-Worker-Auth": localStorage.getItem("workerAuth") || "", "content-type": "application/json" };
}
function saveToken() {
  localStorage.setItem("workerAuth", document.getElementById("authToken").value.trim());
  refreshStatus();
}
document.getElementById("authToken").value = localStorage.getItem("workerAuth") || "";

async function refreshStatus() {
  const el = document.getElementById("statusLine");
  try {
    const r = await fetch("/oauth/status", { headers: authHeaders() });
    const d = await r.json();
    if (r.status === 401) { el.innerHTML = '<span class="status bad">worker auth token wrong or missing</span>'; return; }
    el.innerHTML = d.authorized
      ? '<span class="status ok">connected</span> shop ' + d.shop_id + ' · token good until ' + new Date(d.expires_at).toLocaleString()
      : '<span class="status bad">not connected to Etsy yet</span>';
  } catch (e) { el.textContent = "error: " + e.message; }
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
async function connectEtsy() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = b64url(verifierBytes.buffer).slice(0, 64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)).buffer);
  localStorage.setItem("pkce_verifier", verifier);
  localStorage.setItem("pkce_state", state);
  const redirectUri = ORIGIN + "/oauth/callback";
  const url = "https://www.etsy.com/oauth/connect?response_type=code"
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&scope=" + encodeURIComponent(SCOPE)
    + "&client_id=" + encodeURIComponent(CLIENT_ID)
    + "&state=" + encodeURIComponent(state)
    + "&code_challenge=" + encodeURIComponent(challenge)
    + "&code_challenge_method=S256";
  window.location.href = url;
}

async function loadFixes() {
  const container = document.getElementById("fixes");
  container.innerHTML = "<p class='muted'>loading…</p>";
  try {
    const r = await fetch("/listings?state=active&limit=100", { headers: authHeaders() });
    if (r.status === 401) { container.innerHTML = "<p class='status bad'>worker auth token wrong or missing</p>"; return; }
    const data = await r.json();
    const listings = data.results || [];
    container.innerHTML = "";
    for (const fix of FIXES) {
      const listing = listings.find(l => l.title.includes(fix.match));
      const card = document.createElement("div");
      card.className = "card";
      if (!listing) {
        card.innerHTML = "<p class='muted'>No live listing matched \\"" + fix.match + "\\" — skipping.</p>";
        container.appendChild(card);
        continue;
      }
      card.innerHTML =
        "<p class='muted'>Listing " + listing.listing_id + " — current title:</p>" +
        "<pre>" + listing.title + "</pre>" +
        "<p class='muted'>New title:</p>" +
        "<textarea id='title-" + listing.listing_id + "' rows='2'>" + fix.newTitle + "</textarea>" +
        "<p class='muted'>New tags (comma separated):</p>" +
        "<textarea id='tags-" + listing.listing_id + "' rows='2'>" + fix.newTags.join(", ") + "</textarea>" +
        "<div class='row'><button onclick='applyFix(" + listing.listing_id + ")'>Apply to this listing</button> <span id='result-" + listing.listing_id + "' class='muted'></span></div>";
      container.appendChild(card);
    }

    const shop = await (await fetch("/shop", { headers: authHeaders() })).json();
    document.getElementById("shopTitleCard").innerHTML =
      "<p class='muted'>Current shop title:</p><pre>" + (shop.title || "") + "</pre>" +
      "<p class='muted'>New shop title:</p><textarea id='shopTitle' rows='2'>" + NEW_SHOP_TITLE + "</textarea>" +
      "<div class='row'><button onclick='applyShopTitle()'>Apply shop title</button> <span id='shopResult' class='muted'></span></div>";
  } catch (e) {
    container.innerHTML = "<p class='status bad'>" + e.message + "</p>";
  }
}

async function applyFix(listingId) {
  const title = document.getElementById("title-" + listingId).value;
  const tags = document.getElementById("tags-" + listingId).value.split(",").map(s => s.trim()).filter(Boolean);
  const resultEl = document.getElementById("result-" + listingId);
  resultEl.textContent = "applying…";
  try {
    const r = await fetch("/listings/" + listingId, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ title, tags }) });
    const d = await r.json();
    resultEl.innerHTML = r.ok ? "<span class='status ok'>applied</span>" : "<span class='status bad'>" + (d.error || "failed") + "</span>";
  } catch (e) { resultEl.innerHTML = "<span class='status bad'>" + e.message + "</span>"; }
}

async function applyShopTitle() {
  const title = document.getElementById("shopTitle").value;
  const resultEl = document.getElementById("shopResult");
  resultEl.textContent = "applying…";
  try {
    const r = await fetch("/shop", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ title }) });
    const d = await r.json();
    resultEl.innerHTML = r.ok ? "<span class='status ok'>applied</span>" : "<span class='status bad'>" + (d.error || "failed") + "</span>";
  } catch (e) { resultEl.innerHTML = "<span class='status bad'>" + e.message + "</span>"; }
}

refreshStatus();
</script>
</body>
</html>`;
}

function callbackHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Connecting to Etsy…</title></head>
<body style="font:15px sans-serif;max-width:600px;margin:60px auto;padding:0 20px;">
<p id="msg">Finishing Etsy connection…</p>
<script>
(async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = localStorage.getItem("pkce_state");
  const verifier = localStorage.getItem("pkce_verifier");
  const msg = document.getElementById("msg");
  if (!code) { msg.textContent = "No authorization code in URL — did you decline access on Etsy?"; return; }
  if (state !== expectedState) { msg.textContent = "State mismatch — please retry from the dashboard (possible stale link)."; return; }
  try {
    const r = await fetch("/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: window.location.origin + "/oauth/callback" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "exchange failed");
    msg.textContent = "Connected to shop " + d.shop_id + "! Redirecting…";
    setTimeout(() => (window.location.href = "/"), 1200);
  } catch (e) {
    msg.textContent = "Failed to connect: " + e.message;
  }
})();
</script>
</body></html>`;
}

async function router(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/") {
    return html(dashboardHtml(url.origin, env.ETSY_CLIENT_ID));
  }

  if (method === "GET" && pathname === "/oauth/callback") {
    return html(callbackHtml());
  }

  if (method === "POST" && pathname === "/oauth/exchange") {
    return handleOauthExchange(request, env);
  }

  // Everything below requires our own shared secret.
  if (!requireWorkerAuth(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (method === "GET" && pathname === "/oauth/status") {
    return handleStatus(env);
  }

  const tokens = await getTokens(env);
  const shopId = tokens?.shop_id;
  if (!shopId) return json({ error: "not authorized yet" }, 400);

  if (method === "GET" && pathname === "/shop") {
    return json(await etsyFetch(env, `/shops/${shopId}`));
  }

  if (method === "PUT" && pathname === "/shop") {
    const body = await request.json();
    return json(
      await etsyFetch(env, `/shops/${shopId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  if (method === "GET" && pathname === "/listings") {
    const state = url.searchParams.get("state") || "active";
    const limit = url.searchParams.get("limit") || "100";
    return json(
      await etsyFetch(env, `/shops/${shopId}/listings?state=${state}&limit=${limit}`)
    );
  }

  if (method === "POST" && pathname === "/listings") {
    const body = await request.json();
    return json(
      await etsyFetch(env, `/shops/${shopId}/listings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  const listingMatch = pathname.match(/^\/listings\/(\d+)$/);
  if (listingMatch) {
    const listingId = listingMatch[1];

    if (method === "GET") {
      return json(await etsyFetch(env, `/listings/${listingId}`));
    }

    if (method === "PATCH") {
      const body = await request.json();
      return json(
        await etsyFetch(env, `/shops/${shopId}/listings/${listingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    }
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
