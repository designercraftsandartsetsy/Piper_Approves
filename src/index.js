// Cloudflare Worker: Etsy shop control plane for DesignerTeesAndHome.
//
// This Worker is the only thing in this project allowed to talk to Etsy's API.
// Every request (other than /oauth/exchange, which bootstraps everything) must
// carry `X-Worker-Auth: <WORKER_AUTH_TOKEN>` so the endpoints aren't open to the
// public internet.

const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const TOKENS_KEY = "tokens";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
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

async function exchangeCodeForTokens(env, code, codeVerifier) {
  const resp = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ETSY_CLIENT_ID,
      redirect_uri: env.ETSY_REDIRECT_URI,
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
  if (!tokens) throw new Error("Not authorized yet — call /oauth/exchange first.");

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
  const { code, code_verifier } = await request.json();
  if (!code || !code_verifier) return json({ error: "code and code_verifier required" }, 400);

  const tokenData = await exchangeCodeForTokens(env, code, code_verifier);
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

async function router(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

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
