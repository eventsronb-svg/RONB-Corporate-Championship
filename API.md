# HTTP API

Base URL: your configured `APP_ORIGIN`. All POST/PATCH/DELETE requests require an `Origin` header matching it. Captain and admin authentication use separate session cookies; there are no tokens stored in browser local storage.

Responses are JSON. Money fields are decimal strings, timestamps are ISO 8601, and IDs are UUIDs. A successful mutation returns the resulting resource unless specified otherwise. Errors follow `{ "error": "code", "message": "description" }`. Validation errors add `details`.

## Authentication

| Method     | Path                          | Behavior                                                       |
| ---------- | ----------------------------- | -------------------------------------------------------------- |
| GET        | `/auth/google`                | Start captain Google OAuth; browser redirect                   |
| GET / POST | `/auth/google/callback`       | Exchange code, create/fetch captain, establish session         |
| GET        | `/auth/me`                    | Current captain `{id,email,name,phone}`                        |
| POST       | `/auth/logout`                | Revoke captain session                                         |
| GET        | `/admin/auth/google`          | Start organizer Google OAuth                                   |
| GET / POST | `/admin/auth/google/callback` | Exchange code, check active allowlist, establish admin session |
| GET        | `/admin/me`                   | Current organizer `{id,email,name,role}`                       |
| POST       | `/admin/auth/logout`          | Revoke admin session                                           |

GET callbacks receive Google's `code` and `state` query parameters. POST callbacks accept `{ "code": "...", "state": "..." }`. Both require the signed browser state cookie from the corresponding start endpoint. Captain GET callback redirects to `/orders/current`; admin GET callback redirects to `/admin`. POST callbacks return `{user: ...}` or `{admin: ...}` and set their session cookie.

## Public

| Method | Path                              | Response                                        |
| ------ | --------------------------------- | ----------------------------------------------- |
| GET    | `/health`                         | `{ "status": "ok" }` after a database check     |
| GET    | `/event`                          | Active event or `null`                          |
| GET    | `/sports`                         | Array of active sports, ordered by name         |
| GET    | `/teams?sport_id=&limit=&offset=` | Array of published teams; sport filter optional |

`/teams` defaults to 50 entries, maximum 100. Each team contains `id`, `team_name`, `logo_url`, `sport_id`, `sport_name`, and ordered `players` names. It excludes captain/payment information. Inactive sports remain associated with historical registrations.

## Captain registration

Every endpoint in this section requires the captain `session` cookie. A foreign order or item is treated as missing (`404`).

| Method | Path                                          | Request / behavior                                                     |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/orders/current`                             | Open order, otherwise latest rejected order, otherwise `null`          |
| POST   | `/orders/draft`                               | Create draft or return existing open order                             |
| PATCH  | `/orders/:id/sports`                          | Full selection replacement; body below                                 |
| POST   | `/orders/:id/phone`                           | `{ "phone_number": "+977 9800000000" }`                                |
| POST   | `/orders/:id/invoice`                         | Lock current prices and total; repeat calls return the frozen invoice  |
| POST   | `/orders/:id/payment-request`                 | Create or return the existing code, QR and expiry                      |
| POST   | `/orders/:id/receipt`                         | Multipart file field `receipt`; creates receipt and submits for review |
| GET    | `/orders/:id/status`                          | Full resumable order, items and payment information                    |
| POST   | `/orders/:id/cancel-and-revise`               | Cancel old order and return a new prefilled draft                      |
| GET    | `/orders/:id/items/:item_id/profile`          | Profile draft, available after confirmation                            |
| PATCH  | `/orders/:id/items/:item_id/profile`          | Save roster and/or upload logo                                         |
| POST   | `/orders/:id/items/:item_id/profile/complete` | Explicit Done; complete item and queue email if it is the last one     |

Sports selection:

```json
{
  "sports": [
    { "sport_id": "<cricket-uuid>", "team_name": "Valley Strikers" },
    { "sport_id": "<football-uuid>", "team_name": "Kathmandu United" }
  ]
}
```

Select 1–30 distinct active sports. Names are trimmed and limited to 120 characters. Selection replaces the previous draft items, so fetch the returned item IDs. After invoice, selection/name changes return `409`.

An order response includes order columns plus:

```json
{
  "items": [
    {
      "id": "<item-uuid>",
      "order_id": "<order-uuid>",
      "sport_id": "<sport-uuid>",
      "sport_name": "Cricket",
      "team_name": "Valley Strikers",
      "price_at_purchase": "1500.25",
      "logo_url": null,
      "profile_completed_at": null,
      "players": []
    }
  ],
  "payment_request": null,
  "rejection": null,
  "resume_step": "sports"
}
```

`resume_step` values: `sports`, `invoice`, `payment`, `receipt`, `awaiting_review`, `team_profile`, `registered`, `cancelled`, `expired`. An order in `phone_captured` resumes at `invoice`; the UI can still edit sports/contact details until invoice creation. A rejected order has `rejection: {notes, verified_at}`.

The payment-request endpoint returns its stored `id`, `order_id`, `unique_code`, `qr_payload`, `expires_at`, `created_at`, plus `qr_data_url` (PNG data URL) and `instructions`. The same request never creates another code. The stored payload is also available in order detail for clients that render their own QR.

Upload examples after obtaining a session cookie:

```sh
curl -b cookies.txt -H 'Origin: http://localhost:3000' \
  -F 'receipt=@payment.png' \
  http://localhost:3000/orders/ORDER_ID/receipt

curl -X PATCH -b cookies.txt -H 'Origin: http://localhost:3000' \
  -F 'logo=@team-logo.png' \
  -F 'players=["Suman Karki","Pratik Gurung"]' \
  http://localhost:3000/orders/ORDER_ID/items/ITEM_ID/profile
```

Profile JSON updates accept `{ "players": ["Suman Karki", "Pratik Gurung"] }`. The array replaces the roster and preserves its submitted order. Multipart updates accept one `logo` file, one JSON `players` field, or both. Arbitrary `logo_url` strings are not accepted; public logos must come through storage. Profiles require a stored logo and 1–100 nonblank player names before Done. A completed profile may be edited without queuing another automatic email.

## Admin orders — staff and super admin

| Method | Path                             | Request / behavior                                                                         |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/admin/orders`                  | Filtered queue, described below                                                            |
| GET    | `/admin/orders/:id`              | Full order, user, signed receipts, timeline, verification notes, email jobs/log, audit log |
| POST   | `/admin/orders/:id/review`       | `receipt_submitted` → `under_review`                                                       |
| POST   | `/admin/orders/:id/verify`       | `{ "decision": "confirmed", "notes": "Amount and code match" }`                            |
| POST   | `/admin/orders/:id/contact`      | `{ "notes": "Called captain" }`; confirmed → contacted                                     |
| POST   | `/admin/orders/:id/complete`     | contacted → completed                                                                      |
| POST   | `/admin/orders/:id/resend-email` | Queue manual resend; payment and every profile must already be complete                    |
| POST   | `/admin/orders/:id/cancel`       | **Super admin only**; `{ "reason": "Registration withdrawn" }`                             |

`verify.decision` is `confirmed` or `rejected`. Rejection requires nonblank notes. Only submitted/under-review orders can be verified. No email is queued by payment verification alone. Verification is transactional: simultaneous conflicting decisions yield one success and one `409`.

Queue query parameters:

| Parameter              | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `status`               | Default `receipt_submitted`; any order status or `all`       |
| `search`               | Captain name/email, team name, order UUID text, payment code |
| `sport_id`             | Registered sport UUID                                        |
| `date_from`, `date_to` | Inclusive creation time bounds as ISO timestamps             |
| `limit`, `offset`      | Default 50/0; max limit 100                                  |

Response: `{ "orders": [...], "limit": 50, "offset": 0 }`. Queue rows include `captain_name`, `email`, `teams`, `unique_code`, and the latest `receipt_submitted_at` in addition to order fields.

Admin detail receipts contain `{id, uploaded_at, signed_url, expires_in: 300}`. Refresh detail to obtain new signed URLs. Original private object keys are omitted. `email_jobs` exposes queue state, attempts and last error so stalled delivery is visible; `email_log` records individual delivery attempts and provider IDs.

## Admin configuration — super admin only

| Method | Path                | Request / response                                                                       |
| ------ | ------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/admin/sports`     | Array of all sports, including inactive ones                                             |
| POST   | `/admin/sports`     | `{ "name": "Cricket", "price": "1500.00", "description": "...", "active": true }`; `201` |
| PATCH  | `/admin/sports/:id` | Any nonempty subset of the create fields                                                 |
| DELETE | `/admin/sports/:id` | Set `active=false`; preserve historical registrations                                    |
| GET    | `/admin/event`      | Active event or `null`                                                                   |
| PATCH  | `/admin/event`      | Edit active event, or create the initial one                                             |
| GET    | `/admin/admins`     | Array of organizer accounts                                                              |
| POST   | `/admin/admins`     | `{ "email": "organizer@example.com", "role": "staff" }`; `201`, adds allowlist entry     |
| PATCH  | `/admin/admins/:id` | `{ "role": "staff", "active": false }`; either or both fields                            |

Event fields: `title`, `description`, `start_date`, `end_date`, `venue`. Supply all fields to create the first event; subsequent PATCH requests accept a subset. Dates must include a timezone, and the end must not precede the start. There is at most one active event.

Organizer roles: `staff` and `super_admin`. Email matching is case-insensitive. Newly invited accounts have no Google subject until first verified login. No invitation email is sent. Removing/demoting the last active super admin returns `409`.

## Admin captains — staff and super admin

| Method | Path                                  | Response                                        |
| ------ | ------------------------------------- | ----------------------------------------------- |
| GET    | `/admin/users?search=&limit=&offset=` | `{users,limit,offset}`; search name/email/phone |
| GET    | `/admin/users/:id`                    | Captain profile plus full order history         |

## Background execution

No unauthenticated job-trigger HTTP endpoints exist. Start `npm run worker`, or run the compiled `dist/worker-main.js` in production. It performs expiry cleanup and delivers queued mail. See [README.md](./README.md) for retry, lease and idempotency behavior.
