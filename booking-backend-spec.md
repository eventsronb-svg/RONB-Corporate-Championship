# Sports Event Registration Backend — Developer Spec

**Contents:** [1. Overview](#1-overview) · [2. Tech Stack & Services](#2-tech-stack--services) ·
[3. User Journey](#3-user-journey) · [4. Order State Machine](#4-order-state-machine) ·
[5. Data Model](#5-data-model) · [6. API Endpoints](#6-api-endpoints) ·
[7. Business Rules](#7-business-rules-decided) · [8. Confirmation Email](#8-confirmation-email) ·
[9. Background Jobs](#9-background-jobs) · [10. Edge Cases](#10-edge-cases) ·
[11. Admin Panel](#11-admin-panel) · [12. Not Built Yet](#12-not-built-yet-future-considerations)

## 1. Overview

A public event registration site: teams sign in with Google, register for
one or more sports, and pay via a manually-verified QR/remarks-code transfer
(no payment gateway integration). After admin approves payment, the captain
completes their team's public profile (logo + roster). A team appears on the
homepage, segmented by sport, only once **both** payment is confirmed **and**
the profile is complete. Once every team on an order is fully done, one
confirmation email goes out (Section 8) — content/template supplied
separately.

Core design principle: **the order row is the single source of truth for
where a registration is in the flow.** Every step writes to the order, so a
captain can close the tab at any point and resume exactly where they left
off on next login.

---

## 2. Tech Stack & Services

| Concern | Service | Notes |
|---|---|---|
| Database | **Neon** (Postgres) | Serverless Postgres — schema in Section 5 applies as-is. Use Neon's built-in connection pooler (pgbouncer-compatible) rather than raw connections, since short-lived/serverless request handlers open many connections quickly. Neon's branching feature is worth using per-environment (dev/staging branches off production) once there's a CI pipeline. |
| File storage | **Neon Object Storage** (S3-compatible) | Holds both `receipts.file_url` and `order_items.logo_url`. Being S3-compatible, any standard S3 SDK (`@aws-sdk/client-s3`, boto3, etc.) works by pointing the client at Neon's storage endpoint — no new upload logic to invent. |
| Email | **Resend** | Single API call at the one trigger point in Section 8. Resend's send response gives immediate accepted/failed status for `email_log`; webhook-based delivery/bounce tracking is a later add-on (Section 12), not needed to launch. |

**Object storage layout:**
- `receipts/` — **private.** App generates short-lived signed URLs when the admin panel needs to display one; never a public link, since these are payment proof.
- `team-logos/` — **public.** Served directly since they're shown on the public `/teams` listing.

### 2.1 Google OAuth Setup (Google Cloud Console)

Both the public user flow and the admin panel authenticate via Google — same
identity provider, same OAuth client, different backend authorization checks
(regular users auto-create on first login; admins are additionally checked
against the `admins` allowlist table from Section 11.1).

1. **Create a project** in Google Cloud Console named **"Ronb Events"** (one
   project covers both the user-facing site and the admin panel).
2. **Configure the OAuth consent screen**: User type = *External* (public
   users are signing in, not just an internal org). App name "Ronb Events",
   support email, and scopes limited to `openid`, `email`, `profile` — that's
   all this flow needs. These are non-sensitive scopes, so no Google
   verification review is required even in production.
3. **Create an OAuth 2.0 Client ID** (type: Web application). Add authorized
   redirect URIs for every environment that needs one:
   - `https://<prod-domain>/auth/google/callback`
   - `https://<prod-domain>/admin/auth/google/callback`
   - `http://localhost:<port>/auth/google/callback` (and the admin
     equivalent) for local dev
4. **Store the Client ID + Client Secret as environment variables/secrets** —
   never commit them. One shared client is enough; splitting into a separate
   client for the admin panel is optional and not required, since access
   control there is enforced at the app layer (the `admins` table), not by
   having a different OAuth client.
5. **Publish** the consent screen once redirect URIs and scopes are final.

---

## 3. User Journey

| # | Screen | Action | Backend effect |
|---|--------|--------|-----------------|
| 0 | **Landing page (public, no login)** | Views event info + teams, segmented by sport (cricket / football / basketball tabs) | `GET /event` for event details, `GET /teams?sport_id=` per tab. No auth required. |
| 1 | Login | Signs in with Google | User created/fetched. `GET /orders/current` checked — if an open registration exists, captain is routed straight to its matching screen. |
| 2 | Sport selection & team naming | Picks sport(s) to register for; **names a team for each sport individually** — a captain can run different-named teams in different sports | Draft order created on first pick (`POST /orders/draft`). Each pick is an `order_item` carrying its own `team_name` (`PATCH /orders/:id/sports`). Fully editable at this stage. |
| 3 | Contact number | Enters phone, proceeds | `POST /orders/:id/phone` → order moves to `phone_captured`. |
| 4 | Amount shown | Proceeds | `POST /orders/:id/invoice` computes and **permanently locks** `total_amount` across all registered teams/sports. Order → `invoiced`. |
| 5 | QR + code | Sees unique code + QR | `POST /orders/:id/payment-request` generates code, QR payload, expiry. Order → `payment_pending`. |
| 6 | (external) | Pays via QR, types code into transfer remarks | — |
| 7 | Receipt upload | Uploads payment receipt | `POST /orders/:id/receipt` (file → Neon Object Storage `receipts/`) → order → `receipt_submitted`. Repeatable if rejected. |
| 8 | "We'll contact you" | Waits, screen polls status | `GET /orders/:id/status` polled. |
| 9 | (admin side) | Admin reviews receipt vs. expected amount/code | `POST /admin/orders/:id/verify` → `confirmed` or `rejected`. Confirming does not publish the team yet — see step 10. |
| 10 | **Team profile** (per sport, unlocked after confirm) | Captain uploads logo (→ Neon Object Storage `team-logos/`) + enters player names for each registered team, then hits "Done" | `PATCH /orders/:id/items/:item_id/profile`, then `POST /orders/:id/items/:item_id/profile/complete` when finished. |
| 11 | **Listed & confirmed** | Team now appears on the homepage under its sport's tab | Automatic — no separate publish action (Business Rule 6). **Once every team on this order has completed its profile, the one confirmation email fires via Resend** (Section 8). |
| — | Contacted | Team follows up | Order → `contacted` → `completed`, independent of profile completion timing. |

**Editing sports/team names after step 4 is not allowed** (price is locked).
Changing sports after invoicing requires `POST /orders/:id/cancel-and-revise`
— cancels this order, spawns a pre-filled draft.

---

## 4. Order State Machine

```
draft ──> phone_captured ──> invoiced ──> payment_pending ──> receipt_submitted ──> under_review ──> confirmed ──> contacted ──> completed
  │                                              │                    │                    │
  │ (sports + team names editable here)          │                    ├──> rejected ───────┘ (user re-uploads)
  │                                               │                    │
  └── (idle > 7 days) ──> expired                 └── (code idle) ──> expired

Any non-terminal state ──> cancelled  (via cancel-and-revise, spawns new pre-filled draft)
```

Terminal states: `completed`, `cancelled`, `expired`, `rejected` (rejected is
terminal only if the captain never re-uploads).

**Note:** team profile completion (logo + roster) is *not* an order status —
it's a per-`order_item` flag (`profile_completed_at`) that runs in parallel,
since a single order can hold several teams (one per sport) completing their
profiles independently and at different times. The confirmation email fires
once the *last* of them finishes.

---

## 5. Data Model

```sql
users
  id, google_id, email, name, phone (nullable), created_at

sports
  id, name, price, description, active (bool)

events
  id, title, description, start_date, end_date, venue, active (bool), updated_at
  -- typically one active row; admin-editable, drives the landing page content

orders
  id, user_id, status, phone_number (nullable),
  total_amount (nullable until invoiced),
  invoiced_at (nullable),          -- set once; total_amount immutable after this
  confirmed_at (nullable),         -- set on admin confirm
  cancellation_reason (nullable enum: revised | expired | admin_rejected),
  created_at, updated_at

order_items                        -- one row per sport = one team registration
  id, order_id, sport_id, price_at_purchase,
  team_name,
  logo_url (nullable),             -- Neon Object Storage, `team-logos/` (public)
  profile_completed_at (nullable)  -- captain's explicit "Done" on the profile screen

team_players
  id, order_item_id, player_name, created_at

payment_requests
  id, order_id, unique_code, qr_payload, expires_at, created_at

receipts
  id, order_id, file_url, uploaded_at
  -- Neon Object Storage, `receipts/` (private, signed URLs only)

payment_verifications
  id, order_id, admin_id, decision (confirmed | rejected), notes, verified_at

admins
  id, email, name, google_id, role (staff | super_admin), active, created_at

order_status_history
  id, order_id, from_status, to_status, changed_by (nullable admin_id — null if system/job), changed_at

audit_logs
  id, admin_id, action, entity_type, entity_id, metadata (jsonb), created_at

email_log
  id, order_id, user_id, sent_to, status (sent | failed),
  provider_message_id (nullable),  -- Resend's message id, for support lookups
  created_at
```

**Constraint:** partial unique index — only one order per `user_id` where
`status NOT IN (completed, cancelled, expired, rejected)`. Prevents a captain
from having two open registrations at once; `POST /orders/draft` returns the
existing open draft instead of creating a new one.

---

## 6. API Endpoints

**Auth**
```
POST /auth/google/callback
```

**Public**
```
GET  /event                           → landing page event info (no auth)
GET  /teams?sport_id=                 → published teams for one sport tab
GET  /teams                           → all published teams, tagged by sport (for a combined view)
GET  /sports
```

**Order flow (user)**
```
GET   /orders/current                       → resume point on login; null if none open
POST  /orders/draft                         → create, or return existing open draft
PATCH /orders/:id/sports                    → add/remove sport registrations, each with a team_name — 409 if past 'invoiced'
POST  /orders/:id/phone                     → set phone → phone_captured
POST  /orders/:id/invoice                   → compute + lock total_amount → invoiced
POST  /orders/:id/payment-request           → generate code + QR + expiry → payment_pending
POST  /orders/:id/receipt                   → upload receipt to Neon Object Storage → receipt_submitted
GET   /orders/:id/status                    → poll target for the "we'll contact you" screen
POST  /orders/:id/cancel-and-revise         → cancel this order, spawn pre-filled draft

GET   /orders/:id/items/:item_id/profile           → fetch current profile draft
PATCH /orders/:id/items/:item_id/profile           → save logo (→ Neon Object Storage) + players[] — only allowed once order is confirmed+
POST  /orders/:id/items/:item_id/profile/complete  → sets profile_completed_at; team becomes publicly visible; if this was the last incomplete item on the order, queues the Resend confirmation email
```

**Admin — auth**
```
POST /admin/auth/google/callback      → restricted to accounts present in `admins`
GET  /admin/me
```

**Admin — orders**
```
GET  /admin/orders?status=&search=&sport_id=&date_from=&date_to=
GET  /admin/orders/:id                → full detail: per-sport teams, receipts, timeline, email log
POST /admin/orders/:id/verify         → { decision: confirmed|rejected, notes }
POST /admin/orders/:id/contact        → { notes } → mark contacted
POST /admin/orders/:id/cancel         → admin-initiated cancel, { reason }
POST /admin/orders/:id/resend-email   → manual resend via Resend if a captain says they never got it
```

**Admin — sports (super_admin only)**
```
GET    /admin/sports
POST   /admin/sports
PATCH  /admin/sports/:id              → price/name/active — affects future orders only
DELETE /admin/sports/:id              → soft delete (active=false); never hard-delete
```

**Admin — event content (super_admin only)**
```
GET   /admin/event
PATCH /admin/event                    → edit landing page title/description/dates/venue
```

**Admin — users**
```
GET /admin/users?search=
GET /admin/users/:id                  → profile + full order history
```

**Admin — team management (super_admin only)**
```
GET   /admin/admins
POST  /admin/admins                   → invite by email
PATCH /admin/admins/:id               → change role / deactivate
```

---

## 7. Business Rules (decided)

1. **Price is frozen permanently at `invoiced_at`.** Never re-computed, never
   re-priced — regardless of whether the order later expires, gets paid late,
   or anything else.
2. **Sports/team names are editable only before `invoiced`.** After that, the
   only path to change them is cancel-and-revise, which creates a new order
   (fresh pricing) rather than mutating the old one.
3. **One open order per user at a time**, enforced at the DB level.
4. **Login always resumes the in-progress order** via `GET /orders/current` —
   the frontend has no independent step-tracking state.
5. **Receipts are re-uploadable.** A `rejected` order loops back to
   `receipt_submitted` rather than dying.
6. **Public listing requires two independent gates: order `confirmed`
   (or later) AND `order_items.profile_completed_at` set.** Admin approving
   payment is necessary but not sufficient — the captain still has to finish
   their team's profile before it shows up. `/teams` simply filters on both
   conditions; there's no manual "publish" toggle anywhere.
7. **A team is per sport, not per order.** A captain registering for cricket
   and football has two independent `order_items` — separate name, logo,
   and roster — even though they're one payment/order.
8. **Exactly one confirmation email per order, fired once, at the very end**
   — when every `order_item` on the order has `profile_completed_at` set.
   Nothing goes out earlier in the flow. Email delivery failure never blocks
   or alters the order's actual status.

---

## 8. Confirmation Email

**One email, one trigger, sent via Resend.** When the *last* incomplete
`order_item` on an order gets its `profile_completed_at` set — every team
the captain registered is fully done — the system fires a single
confirmation email to `users.email` (from Google OAuth).

- **Content/template**: supplied separately — this spec only defines the
  trigger and delivery mechanics.
- **Data available to the template**: captain name/email, order id, the full
  list of teams on the order (team name, sport, roster, logo URL), total
  amount paid, event details.
- **Sending**: single `resend.emails.send(...)` call, queued after the DB
  write that sets the final `profile_completed_at` — async, via a background
  worker, never blocking the captain's "Done" click.
- **`email_log`**: records `provider_message_id` from Resend's response plus
  `sent`/`failed` status, for support lookups — never drives app logic.
- **Delivery/bounce tracking beyond initial accept**: Resend supports
  webhooks for this; not needed to launch (Section 12).
- **Manual resend**: `POST /admin/orders/:id/resend-email` re-triggers the
  same Resend call for "captain says they never got it."

---

## 9. Background Jobs

- **Draft cleanup**: orders idle in `draft`/`phone_captured` for 7+ days with
  no `invoiced_at` → mark `expired`.
- **Payment code expiry**: `payment_pending` orders past `payment_requests.expires_at`
  with no receipt → mark `expired`.
- **Email delivery worker**: consumes the queue from Section 8, calls Resend,
  writes the result to `email_log`, retries a bounded number of times on
  transient failure.

---

## 10. Edge Cases

- **Missing/garbled code in remarks**: admin verification screen shows
  receipt image + expected amount + code side by side.
- **Underpaid/overpaid**: admin rejects with notes; captain re-uploads.
- **Double order attempt**: blocked by the partial unique constraint.
- **Concurrent tab edits**: last-write-wins on `PATCH /orders/:id/sports` is
  acceptable given the low stakes.
- **Confirmed but profile never completed**: team never appears on the
  homepage, and the confirmation email never fires either, since both are
  gated on the same condition. No error state — worth a future reminder
  (Section 12) once volume makes it worth nudging captains.
- **Logo upload**: unlike receipts (private), logos go to the public
  `team-logos/` prefix in Neon Object Storage, served directly.
- **Email bounces / typo'd address**: since the address comes straight from
  Google, this should be rare — Resend reports a hard bounce, logged as
  `failed` in `email_log`; it never blocks the in-app flow.

---

## 11. Admin Panel

### 11.1 Auth & roles

Admins log in with Google, checked against an `admins` table rather than
open signup — an unrecognized email is rejected, not turned into a regular
user.

| Role | Can do |
|---|---|
| `staff` | View order queue, review receipts, verify/reject, mark contacted, view users |
| `super_admin` | Everything staff can, plus manage sports/pricing, event content, admin accounts, admin-cancel any order |

### 11.2 Screens

**Queue (default landing page)** — orders filtered by status, defaulting to
`receipt_submitted`. Columns: user, teams (one per sport in this order),
amount, code, time since submission.

**Order detail** — full order view: user info, each registered team listed
separately (sport, team name, and once filled — logo/roster), payment code +
QR issued, receipt image(s) (via signed URL from Neon Object Storage), full
timeline, email log for this order, and action buttons (Confirm / Reject /
Mark Contacted / Cancel / Resend Email). Whether a team's profile is
complete yet is shown per team here too, since that gates both public
visibility and the confirmation email.

**Sports management** (`super_admin`) — list, add, edit price/name,
deactivate. Editing a price here never touches existing invoiced orders —
enforced by `invoiced_at` locking.

**Event content** (`super_admin`) — edit the landing page's title,
description, dates, and venue.

**Users** — searchable list, each with their order history.

**Team** (`super_admin`) — manage admin accounts and roles.

### 11.3 Verification workflow

1. Admin opens an order from the queue.
2. Compares receipt image against `payment_requests.unique_code` and
   `orders.total_amount`.
3. **Confirm** → `payment_verifications` row written, order → `confirmed`.
   Captains are now unlocked to fill their team profile(s). No email fires
   yet — that waits until every team's profile is done.
4. **Reject** → notes required, order → `rejected`; captain sees a re-upload
   prompt on next visit.
5. **Mark Contacted** is a separate, later action — not tied to profile
   completion, publication, or the confirmation email.

### 11.4 Audit logging

Every mutating admin action writes to `audit_logs` (admin_id, action, JSON
snapshot). Separate from `order_status_history`, which is order-specific,
and from `email_log`, which is Resend-delivery-specific.

---

## 12. Not Built Yet (future considerations)

- Resend webhook integration for delivery/bounce/open tracking beyond
  initial accept status.
- Reminder notification to captains who are confirmed but haven't completed
  their team profile yet (and so haven't received the confirmation email).
- Automated bank/wallet statement matching.
- SMS/push alongside email for time-sensitive steps.
- Reporting/analytics (registrations by sport, daily volume).
- Neon branch-per-environment CI setup (dev/staging branches off prod).
