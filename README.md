# Work Orders Dashboard

A single-screen decision dashboard that pulls live work orders from the CriticalAsset GraphQL API and surfaces what needs attention right now.

## Setup

**Requirements:** Node.js 18 or later.

```bash
# 1. Install dependencies
npm install

# 2. Add your credentials
cp .env.example .env
# Then open .env and fill in both values:
#   CA_CLIENT_ID=your_client_id_here
#   CA_CLIENT_SECRET=your_client_secret_here

# 3. Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Description |
|---|---|
| `CA_CLIENT_ID` | OAuth2 client ID from CriticalAsset |
| `CA_CLIENT_SECRET` | OAuth2 client secret from CriticalAsset |
| `PORT` | (optional) Server port, defaults to `3000` |

## Security — credentials never reach the client

`CA_CLIENT_SECRET` is read exclusively by the Express backend (`server.js`) at startup via `process.env`. It is used only to exchange for a short-lived Bearer token via the OAuth2 client-credentials flow (POST to `https://api.criticalasset.com/oauth/token`). **That secret is never included in any HTTP response, never logged, and is not referenced anywhere in the `public/` directory.**

The browser only ever calls `GET /api/work-orders` on this server. The backend caches the Bearer token in memory (expires 60 s before the upstream `expires_in`), then proxies the GraphQL request to CriticalAsset. The Bearer token itself is also never forwarded to the frontend — the backend returns only the `workOrders` array.

`.env` is listed in `.gitignore` so credentials can never be accidentally committed.

## Features

- **Overdue counter** — prominently highlighted in red; overdue = `dueDate` in the past and status is not closed.
- **Open / In Progress counters** — at a glance load summary.
- **Filter** by status and priority simultaneously.
- **Sorted table** — overdue rows first, then by priority (Critical → High → Medium → Low), then by due date ascending.
- **Priority colour coding** — Critical (red), High (orange), Medium (yellow), Low (green).
- **Detail panel** — click any row for full work order info including linked asset, location, and assignee.
