require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory token cache — never exposed to the client
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CA_CLIENT_ID,
    client_secret: process.env.CA_CLIENT_SECRET,
    scope: 'workorders:read',
  });

  const res = await fetch('https://api.criticalasset.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token request failed with status ${res.status}`);
  }

  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return tokenCache.token;
}

function clearToken() {
  tokenCache = { token: null, expiresAt: 0 };
}

const WORK_ORDERS_QUERY = `
  query FetchWorkOrders($limit: Int!) {
    workOrders(limit: $limit) {
      id title status priority createdAt dueDate
      asset { id name category }
      location { id locationName address }
      assignee { id name }
    }
  }
`;

async function callGraphQL(token) {
  const res = await fetch('https://api.criticalasset.com/api', {
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
      return res.status(403).json({ error: 'Missing scope — ensure your credentials include workorders:read' });
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
      return res.status(502).json({ error: `Upstream API error: ${apiRes.status}` });
    }

    const payload = await apiRes.json();

    if (payload.errors) {
      console.error('GraphQL errors:', payload.errors);
      return res.status(502).json({ error: payload.errors[0]?.message || 'GraphQL error' });
    }

    const workOrders = payload?.data?.workOrders ?? [];
    return res.json(workOrders);
  } catch (err) {
    // Log message only — never log the token or credentials
    console.error('Error fetching work orders:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Work Orders Dashboard running at http://localhost:${PORT}`);
});
