# Ronb Events — registration backend

Implementation of [booking-backend-spec.md](./booking-backend-spec.md). TypeScript + Fastify, PostgreSQL/Neon, Google OAuth, S3-compatible Neon Object Storage, and a Resend background worker. Includes the organizer admin panel at `/admin`.

## Run locally

Requires Node.js 22.16+ and PostgreSQL 16+. Node 24 is used in the Docker image and CI.

```sh
npm ci
cp .env.example .env
# Fill in .env, including a random COOKIE_SECRET of at least 32 characters.
# If Docker is available, start the included local PostgreSQL service:
docker compose up -d db
npm run migrate
# Set SEED_ADMIN_EMAIL to your Google account in .env, then:
npm run seed
npm run dev
```

In a second terminal:

```sh
npm run worker
```

Open **http://localhost:3000/admin**. The initial admin seed is deliberately one-time; additional organizers are managed through the panel. Seeding does not create sample sports or invent prices. Add the event and its sports through the admin panel.

You can use an existing local PostgreSQL installation or a Neon branch instead of Docker. Set `DATABASE_URL` accordingly. Missing OAuth/storage/payment configuration returns a clear `503` when that integration is used. Production startup requires every integration setting.

The public registration frontend is an API consumer, not included in this backend project. `/` is a small service index; `/event`, `/sports`, `/teams`, and the captain endpoints provide its data.

## Test

No service credentials are needed. Tests never send real email, invoke a bank, or access a Google account.

```sh
npm run check            # Type checking, integration tests using PGlite, production build
npm run test:postgres    # Same tests on a temporary native PostgreSQL server; cleaned up afterward
npx playwright install chromium
npm run test:browser     # Real Chromium tests of the admin panel at desktop/mobile sizes
npm run check:all        # All of the above checks (after Chromium is installed)
```

PGlite runs PostgreSQL compiled to WebAssembly; it is not used in production. The native suite tests actual concurrent connections, row locks, unique constraints, and worker claims. Native PostgreSQL tests can also use a provided `TEST_DATABASE_URL`. **That database is cleared between tests and its name must end in `_test`. Never use a database containing data you want to retain.** CI uses a disposable PostgreSQL 17 service.

Browser tests start a separate local fixture server, seed registrations, and inject test-only session records. These helpers exist only in `tests/` and are excluded from the production build. The tests exercise login presentation, receipt review, confirmation/contact actions, sports prices, event editing, invitations, captain search, role-specific navigation, and mobile overflow. Screenshots and failure traces go to `test-results/`.

## Configure services

### Google sign-in

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `APP_ORIGIN` (origin only, without a trailing slash). Register these redirect URIs for each environment:

- `${APP_ORIGIN}/auth/google/callback`
- `${APP_ORIGIN}/admin/auth/google/callback`

Start the browser flow with `GET /auth/google` or `GET /admin/auth/google`. Only `openid email profile` scopes are requested. Authorization codes are exchanged on the server using PKCE; signed browser-bound state is single-use and expires after 10 minutes. Google identity tokens are verified by the Google library, including audience, signature, expiry, and verified email. Admin login checks the active allowlist and binds its Google subject on first login. It does not auto-create a regular user for an unauthorized admin.

Sessions use random opaque tokens, stored as SHA-256 hashes in PostgreSQL. User and admin cookies are separate, HttpOnly, SameSite=Lax, and Secure in production. Both expire after seven days. Admin activity and role are checked on every request; deactivation revokes sessions immediately.

Google redirects use the implemented `GET` callbacks. The `POST` callbacks from the spec also accept `{ "code": "...", "state": "..." }` with the same browser-state cookie.

All mutating requests require `Origin: ${APP_ORIGIN}`, including curl and multipart uploads. Serve the frontend and API on the same origin, or reverse-proxy the API there. Cross-origin credentialed access is intentionally not enabled. Deploy behind HTTPS in production.

### Neon PostgreSQL

Use the **pooled Neon connection string** with its TLS parameters intact, e.g. `sslmode=require`. The API uses a bounded `pg` pool; each transaction pins a connection through commit/rollback. Migrations use a transaction-scoped advisory lock and a migration ledger, so repeated runs are safe. No session-scoped locks or prepared statement names are required.

### Neon Object Storage

Configure the branch's S3 endpoint, region, and credentials in `.env`.

Create two buckets in Neon:

| Setting              | Visibility      | Stored objects               |
| -------------------- | --------------- | ---------------------------- |
| `S3_RECEIPTS_BUCKET` | **Private**     | `receipts/<uuid>.(png\|pdf)` |
| `S3_LOGOS_BUCKET`    | **Public read** | `team-logos/<uuid>.png`      |

Set `S3_LOGOS_PUBLIC_URL` to the public base URL of the logos bucket, without the `team-logos/` suffix. The application does not modify ACLs; Neon configures visibility at bucket level. See [Neon's Object Storage architecture](https://neon.com/blog/building-neon-object-storage).

`receipts.file_url` stores an object key, never a public URL. Only authorized admin detail requests receive a signed URL, valid for 300 seconds. Captain and public APIs never expose receipt keys or URLs. The panel displays payment amount/code alongside receipt proof; PDFs can be opened through the signed original link.

Uploads are limited to 5 MB. Logos accept PNG/JPEG/WebP; receipts also accept PDFs with a PDF signature. Images are decoded and re-encoded as PNG, stripping metadata and rejecting unsupported/malformed inputs. Logos fit within 1024×1024; decompression is limited to 20 million pixels. Files use generated keys. A failed database update deletes its newly uploaded object where storage is reachable. Replaced logos and crash-orphaned objects need a later storage-retention sweep; no unrelated files are deleted automatically.

### Payment QR

Set `PAYMENT_QR_TEMPLATE` to the **actual merchant-provided bank/wallet payload**. It can be a static merchant QR payload. `{amount}` and `{code}` replacements are available only if the receiving provider supports that payload format. A real PNG QR data URL is returned with the stored payload, unique remarks code, and expiry.

No bank-specific QR format is assumed. No fake payable QR is generated when configuration is missing. The captain must enter the unique code in transfer remarks and pay the exact invoice amount. The default code lifetime is 24 hours; adjust `PAYMENT_EXPIRY_MINUTES` and `PAYMENT_INSTRUCTIONS` as needed.

### Resend

Set `RESEND_API_KEY` and `EMAIL_FROM` using a verified sending domain. The default plain-text confirmation template is in `queueEmail` in `src/orders.ts`; replace its copy when the final template is supplied. It includes captain, order, amount, every team's logo/roster, and event details.

The last completed profile and its unique confirmation job commit in one transaction. The worker sends after that commit, writes accepted/failed results to `email_log`, and retries transient failures up to five attempts with exponential backoff. A network timeout is bounded to 15 seconds. Sending does not change the order status. Manual resends create separate jobs and are throttled to one per minute per order.

Each job freezes its payload and uses `email-job/<job-id>` as the Resend idempotency key. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, a lease token, and recovery after five minutes. Resend retains idempotency keys for [24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys); automatic recovery stops after 23 hours from the first attempt to avoid duplicate sends after that window. A stopped/ambiguous job requires admin review and an explicit manual resend. This provides one automatic confirmation job per order and deduplicated provider retries within the provider's guarantee; no distributed email provider offers an unlimited exactly-once guarantee.

`sent` means Resend accepted the message. Delivery, bounce, and open tracking require the deferred webhook integration and are not inferred from the send response.

## API contract

See [API.md](./API.md) for all endpoints and request bodies.

Money is represented as **decimal strings** (for example `"3500.75"`) and calculated in PostgreSQL `numeric`, avoiding JavaScript floating-point totals. Admin prices accept decimal strings or numbers with at most two decimal places. Dates are ISO 8601 timestamps; IDs are UUIDs.

Expected failures return `{ "error": "code", "message": "..." }`; validation errors also contain a `details` array. Invalid data returns `400`, unauthenticated access `401`, forbidden roles/origins `403`, missing or foreign orders `404`, state/uniqueness conflicts `409`, throttles `429`, and missing integrations `503`.

## Rules and decisions

- The database partial unique index enforces one open order per captain. All captain writes lock the captain, then the order. Concurrent draft creation returns the same order, and concurrent invoice/selection changes serialize.
- Prices are refreshed from active sports **when invoicing**, then the total, invoice timestamp, purchased prices, sports, and team names become immutable through database triggers. Revisions create a new order with current prices.
- Selecting sports uses full replacement. Duplicate sports, blank team names, and inactive sports are rejected. Selections remain editable in `phone_captured` until invoicing.
- `GET /orders/current` returns an open order first; if none exists, it returns the latest rejected order so its captain can re-upload. Creating a new draft is allowed after rejection; re-uploading the older order then returns `409` until the newer open order is resolved.
- `cancel-and-revise` also accepts expired and rejected orders so captains can recover from expiry. It preserves names/contact information and copies only active sports. Logos, rosters, and completion flags start fresh. Completed or already-cancelled orders cannot be revised.
- A payment request is idempotent and its code is never renewed in place. Expired unpaid codes require revision. A rejected receipt can be resubmitted even after the original code expiry because a transfer is already under dispute.
- A profile requires a logo and at least one nonblank player (maximum 100); no sport-specific roster size was supplied. Roster order is preserved. Profiles can be edited after completion without duplicating confirmation; updates must retain a valid roster/logo.
- Public teams require status `confirmed`, `contacted`, or `completed` **and** that item's completion timestamp. Publication does not require all other teams on the same order to finish. It does not expose captain contact or payment information.
- Contact/completion is independent of profile completion. Completed orders are excluded from the current-open-order response; their profiles remain accessible by the existing order ID. The consuming frontend should retain links to an order it is finishing.
- Added `/admin/orders/:id/review` and `/complete` to make the specified `under_review` and `completed` states reachable. Super admins can cancel any order; staff can request manual resends. Cancellation notes live in the audit log, with `admin_rejected` as the schema's admin-cancellation category.
- Organizer “invite” means adding an email to the allowlist. No invitation email is sent. The last active super admin cannot be demoted or deactivated, even through concurrent requests.
- Mutating admin actions, including login/logout, are audited transactionally. Opening details is read-only; starting review is an explicit action.
- The worker checks expiry once a minute, in batches of 100. It leaves receipt-submitted/reviewed and already-invoiced amounts untouched. Only uninvoiced drafts/phone-captured orders idle seven days and unpaid, expired payment requests are expired.

## Production deployment

```sh
npm ci
npm run build
npm run migrate
npm start
# Separate supervised process:
node --env-file-if-exists=.env dist/worker-main.js
```

The API and worker share `DATABASE_URL` and service configuration. Run migrations before starting either. The API health endpoint is `/health`; it checks database connectivity. Run the worker as a persistent supervised process, not inside a short-lived request handler. If using a serverless API host, deploy the worker separately. Both processes shut down on SIGINT/SIGTERM.

A production Dockerfile is included:

```sh
docker build -t ronb-events .
docker run --rm --env-file .env ronb-events node dist/cli.js migrate
docker run --rm --env-file .env -p 3000:3000 ronb-events
docker run --rm --env-file .env ronb-events node dist/worker-main.js
```

Use production values in the supplied environment. No `.env` file or test fixtures are copied into the image. The runtime runs as the unprivileged `node` user. `compose.yaml` is only the local development database, bound to localhost. API rate limits are per process; put a shared rate limit at the ingress if deploying multiple API replicas. Configure the ingress to forward requests on the same origin; the server does not trust arbitrary forwarded IP headers.

## Project structure

```text
migrations/             PostgreSQL schema, constraints, invoice immutability triggers
src/app.ts              HTTP setup, public/captain routes, upload handling
src/auth.ts             OAuth state, sessions, role guards
src/orders.ts           Transactional registration flow and email queue creation
src/admin.ts            Organizer API and audit writes
src/providers.ts        Google, Neon S3 and Resend integrations
src/jobs.ts              Expiry and leased email delivery
src/server.ts           API entry point
src/worker-main.ts      Worker entry point
src/cli.ts              Migration and initial-admin commands
public/                 Admin panel HTML, CSS and browser JavaScript
tests/                  Integration, concurrency and browser tests
scripts/test-postgres.ts Disposable native PostgreSQL runner
```

### Still supplied by the event organizer

Google/Neon/Resend credentials, the bank's merchant QR payload, real event/sport details and prices, and the final email copy. Live OAuth, storage access policies, bank QR acceptance, and Resend delivery must be checked against those real accounts before launch. Automated tests use controlled provider substitutes; the source adapters are implemented but are not a claim of live account verification.
fff