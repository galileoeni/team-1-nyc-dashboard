require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = 'https://100amsterdam.stg.criticalasset.com/api';

// In-memory token cache — never exposed to the client
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation ApplicationToken($input: ApplicationClientCredentialsInput!) { applicationClientCredentialsToken(input: $input) { accessToken tokenType expiresIn refreshToken scope } }',
      variables: {
        input: {
          clientId: process.env.CA_CLIENT_ID,
          clientSecret: process.env.CA_CLIENT_SECRET,
          scope: 'workorders.read assets.read locations.read',
        },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    console.error(`[token] ${res.status} from auth mutation:`, body);
    throw new Error(`Auth request failed with status ${res.status}: ${body}`);
  }

  const payload = await res.json();

  if (payload.errors || !payload.data?.applicationClientCredentialsToken) {
    console.error('[token] auth mutation errors:', JSON.stringify(payload.errors ?? payload, null, 2));
    const msg = payload.errors?.[0]?.message || 'Auth mutation returned no token';
    throw new Error(msg);
  }

  const { accessToken, expiresIn } = payload.data.applicationClientCredentialsToken;
  tokenCache = {
    token: accessToken,
    expiresAt: now + expiresIn * 1000,
  };

  return tokenCache.token;
}

function clearToken() {
  tokenCache = { token: null, expiresAt: 0 };
}

const WORK_ORDERS_QUERY = `
  query FetchWorkOrders($limit: Int!) {
    workOrders(limit: $limit) {
      totalCount
      nodes {
        id
        title
        description
        severity
        executionPriority
        workOrderStage { name }
        endDate
        location { id locationName address }
      }
    }
  }
`;

async function callGraphQL(token) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: WORK_ORDERS_QUERY,
      variables: { limit: 25 },
    }),
  });
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/work-orders', async (req, res) => {
  try {
    if (!process.env.CA_CLIENT_ID || !process.env.CA_CLIENT_SECRET) {
      return res.status(500).json({ error: 'CA_CLIENT_ID and CA_CLIENT_SECRET must be set in .env' });
    }

    let token = await getToken();
    let apiRes = await callGraphQL(token);

    // 401: discard cache, fetch fresh token, retry once
    if (apiRes.status === 401) {
      clearToken();
      token = await getToken();
      apiRes = await callGraphQL(token);
    }

    if (apiRes.status === 401) {
      return res.status(401).json({ error: 'Authentication failed — check CA_CLIENT_ID and CA_CLIENT_SECRET' });
    }

    if (apiRes.status === 403) {
      return res.status(403).json({ error: 'Missing scope — ensure your credentials include workorders.read' });
    }

    if (apiRes.status === 429) {
      const retryAfter = parseInt(apiRes.headers.get('retry-after') || '2', 10);
      await sleep(retryAfter * 1000);
      apiRes = await callGraphQL(token);
      if (apiRes.status === 429) {
        return res.status(429).json({ error: 'Rate limited — please try again shortly' });
      }
    }

    if (!apiRes.ok) {
      const body = await apiRes.text().catch(() => '(unreadable)');
      console.error(`[graphql] ${apiRes.status} from /api:`, body);
      return res.status(502).json({ error: `Upstream API error: ${apiRes.status}`, detail: body });
    }

    const payload = await apiRes.json();

    if (payload.errors) {
      console.error('[graphql] errors array:', JSON.stringify(payload.errors, null, 2));
      return res.status(502).json({ error: payload.errors[0]?.message || 'GraphQL error', graphqlErrors: payload.errors });
    }

    const workOrders = payload?.data?.workOrders?.nodes ?? [];
    return res.json(workOrders);
  } catch (err) {
    console.error('[work-orders] caught exception:', err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Work Orders Dashboard running at http://localhost:${PORT}`);
});
