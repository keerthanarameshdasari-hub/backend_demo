# backend_demo

Demo wallet API for the CI/CD demo (`backend_demo`, `admin_demo`, `frontend_demo`, `infra_demo`):
users sign up, pass KYC by uploading an identity document, then top up a wallet through a payment
provider. NestJS + TypeScript on Node 26 (Active LTS), Postgres via Prisma, documents in S3 (MinIO locally).

Branch flow: `feature/*` → `dev` → `test` → `main`, each step by pull request. See
[docs/ci.md](docs/ci.md) for what runs on every pull request.

## Run it

You need Docker with Compose v2.

```sh
docker compose up --build
```

That starts Postgres and MinIO, runs two one-off jobs (create the KYC bucket, apply database
migrations), then starts the API on <http://localhost:3000>. Check it:

```sh
curl localhost:3000/health   # {"status":"ok"}               (process is up)
curl localhost:3000/ready    # {"status":"ready",...}        (database reachable)
```

Defaults come from `.env.example`. To change anything, copy it to `.env` (git-ignored) and edit;
values in `.env` win. Interactive API docs are at <http://localhost:3000/docs> when
`NODE_ENV` isn't `production`. The MinIO console is at <http://localhost:9001>.

### Without Docker for the API

```sh
docker compose up -d postgres minio create-bucket
cp .env.example .env    # then point DATABASE_URL and S3_ENDPOINT at localhost
npm ci
npx prisma migrate deploy
npm run start:dev
```

### A full walk-through

```sh
API=localhost:3000
curl -s -XPOST $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"asha@example.com","password":"correct-horse-battery","fullName":"Asha Rao"}'
TOKEN=$(curl -s -XPOST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"asha@example.com","password":"correct-horse-battery"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

curl -s -XPOST $API/kyc -H "authorization: Bearer $TOKEN" \
  -F documentType=PASSPORT -F documentNumber=P1234567 -F document=@passport.png

curl -s -XPOST $API/wallet/top-ups -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'Idempotency-Key: order-0001' \
  -d '{"amountMinor":50000,"paymentToken":"tok_visa"}'
```

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/health` | – | Liveness. Never touches the database. |
| GET | `/ready` | – | Readiness. 200 when the database answers, 503 otherwise. |
| GET | `/meta/min-app-version` | – | Oldest supported mobile app version (`MIN_APP_VERSION`). |
| POST | `/auth/register` | – | Create an account. |
| POST | `/auth/login` | – | Get a JWT access token. |
| GET | `/users/me` | JWT | The signed-in user, including `role` and `kycStatus`. |
| POST | `/kyc` | JWT | Multipart upload: `documentType`, `documentNumber`, `document` (JPEG/PNG/PDF). |
| GET | `/kyc` | JWT | Latest KYC submission. |
| GET | `/wallet` | JWT | Balance. |
| GET | `/wallet/top-ups` | JWT | Recent top-ups, newest first (`?limit=`, max 100). |
| POST | `/wallet/top-ups` | JWT | Top up. Needs approved KYC. Optional `Idempotency-Key` header. |
| GET | `/admin/users` | Admin | Every user, newest first. `?kycStatus=`, `?limit=` (max 100), `?offset=`. |
| GET | `/admin/kyc` | Admin | Every KYC submission with its owner. `?status=`, `?limit=`, `?offset=`. |
| POST | `/admin/kyc/{id}/approve` | Admin | Override: approve a `REJECTED` or `TIMED_OUT` submission. |
| POST | `/admin/kyc/{id}/reject` | Admin | Override: reject an `APPROVED` or `TIMED_OUT` submission. Body `{ "reason": "…" }`. |
| GET | `/admin/top-ups` | Admin | Every user's top-ups with their owner. `?userId=`, `?status=`, `?limit=`, `?offset=`. |

"Admin" means a JWT whose user has `role: ADMIN`; anyone else gets 403. The role is read from the
database on each request, so demoting someone takes effect immediately. The `admin_demo` portal
is the client for these routes.

### Admins

Nobody can become an admin over the API. An operator promotes an existing account with access to
that environment's database:

```sh
npm run build
npm run admin:promote -- someone@example.com   # needs the API's env vars (DATABASE_URL is the one used)
```

KYC review is an **override**, not a queue: the provider still decides inside `POST /kyc`, and an
admin can then reverse that decision. Only a user's latest submission can be reviewed, a `PENDING`
one (still with the provider) can't be touched, an admin can't review their own submission, and
the reviewing admin is recorded in `reviewedBy`.

Money is always an integer in minor units (`amountMinor: 50000` = ₹500.00).

The full contract is in [`openapi.json`](openapi.json). Regenerate it after changing any controller
or DTO and commit the result:

```sh
npm run openapi         # writes openapi.json (keys sorted, so diffs stay small)
npm run openapi:check   # fails if the committed file is out of date
```

## Mock providers

`PAYMENT_PROVIDER=mock` and `KYC_PROVIDER=mock` choose the outcome from the input, so you can
exercise every path by hand or in tests:

| Provider | Input | Result |
|---|---|---|
| Payment | `paymentToken` starting `tok_reject` | Declined → top-up `FAILED`, no credit |
| Payment | `paymentToken` starting `tok_timeout` | Never answers → top-up `TIMED_OUT`, no credit |
| Payment | any other token, e.g. `tok_visa` | Approved → top-up `SUCCEEDED`, wallet credited |
| KYC | `documentNumber` starting `REJECT` | `REJECTED` (resubmit allowed) |
| KYC | `documentNumber` starting `TIMEOUT` | `TIMED_OUT` (resubmit allowed) |
| KYC | any other number | `APPROVED` |

"Never answers" means the mock waits until the caller gives up after `PROVIDER_TIMEOUT_MS`, which is
exactly what a real slow provider looks like to the app.

## Environment variables

All configuration comes from environment variables, validated at startup by
[`src/config/env.ts`](src/config/env.ts). If anything is missing or invalid the API prints which
variables are wrong (names only, never values) and exits before listening.

| Variable | Required | Example | Meaning |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | `development`, `test` or `production`. `/docs` is off in production. |
| `PORT` | yes | `3000` | HTTP port. |
| `LOG_LEVEL` | yes | `log` | `error`, `warn`, `log`, `debug` or `verbose`. |
| `DATABASE_URL` | yes | `postgresql://wallet:wallet@postgres:5432/wallet` | Postgres connection string. |
| `JWT_SECRET` | yes | 32+ random chars | HMAC key for access tokens. |
| `JWT_ISSUER` | yes | `backend-demo` | `iss` claim, checked on every request. |
| `JWT_EXPIRES_IN_SECONDS` | yes | `3600` | Token lifetime, 60 s – 24 h. |
| `MIN_APP_VERSION` | yes | `1.0.0` | Served by `/meta/min-app-version`. |
| `CORS_ALLOWED_ORIGINS` | no | `https://admin.example.com,http://localhost:5173` | Browser origins allowed to call the API (the admin portal). Exact origins, comma-separated, no `*`. Unset = no CORS. |
| `STORAGE_PROVIDER` | yes | `s3` | Document storage adapter. Only `s3` today (works with MinIO). |
| `PAYMENT_PROVIDER` | yes | `mock` | Payment adapter. Only `mock` today. |
| `KYC_PROVIDER` | yes | `mock` | KYC adapter. Only `mock` today. |
| `PROVIDER_TIMEOUT_MS` | yes | `3000` | Deadline for each payment/KYC call. |
| `S3_BUCKET` | yes | `kyc-documents` | Bucket for KYC documents. |
| `S3_REGION` | yes | `us-east-1` | S3 region. |
| `S3_ENDPOINT` | no | `http://minio:9000` | Set for MinIO; leave unset for AWS. |
| `S3_FORCE_PATH_STYLE` | yes | `true` | `true` for MinIO, `false` for AWS. |
| `S3_ACCESS_KEY_ID` | no* | `minioadmin` | *Set together with the secret, or leave both unset to use the AWS credential chain. |
| `S3_SECRET_ACCESS_KEY` | no* | `minioadmin` | See above. |
| `WALLET_CURRENCY` | yes | `INR` | ISO 4217 currency of all wallets. |
| `TOP_UP_MIN_MINOR` | yes | `100` | Smallest top-up, in minor units. |
| `TOP_UP_MAX_MINOR` | yes | `10000000` | Largest top-up, in minor units. |
| `KYC_MAX_DOCUMENT_BYTES` | yes | `5242880` | Largest accepted document (1 KiB – 20 MiB). |

`.env.example` holds dummy values for every variable. Never commit `.env`; it's git-ignored, and the
gitleaks job in CI scans the whole history for anything that looks like a secret.

## How the code is organised

Loose coupling is the main design goal: business rules don't know which database, storage or
provider they're talking to.

```
src/
  domain/      Business logic as plain TypeScript. Imports nothing from NestJS, Prisma or AWS
               (a test enforces this).
    ports.ts   Interfaces the domain needs: UserRepository, FileStorage, PaymentGateway,
               KycProvider, Clock, plus KycSubmissionRepository, WalletRepository,
               PasswordHasher, IdGenerator, ReadinessProbe.
    *.service.ts  UserService, KycService, WalletService, AdminService.
  adapters/    Implementations of the ports: prisma/, s3/, mock/, system/ (clock, ids, scrypt).
  app/         NestJS wiring. adapters.module.ts is the only place that picks an adapter,
               and it picks only from env config.
  http/        Controllers, DTOs (which also define openapi.json), JWT and admin guards, error mapping,
               request logging.
  config/      Env validation.
  scripts/     generate-openapi, ensure-bucket, promote-admin.
prisma/        Schema and migrations.
test/          unit/ (domain with port fakes, config, adapters, architecture), integration/ (real
               Postgres) and api/ (every endpoint over HTTP). Port fakes live in test/fakes.ts.
```

To add a real payment provider: write `src/adapters/<name>/<name>-payment.gateway.ts` implementing
`PaymentGateway`, add `<name>` to `PAYMENT_PROVIDER` in `env.ts`, and add a `case` in
`createPaymentGateway`. Nothing in `domain/` or `http/` changes.

### Behaviour worth knowing

- **Top-ups never credit on doubt.** Only an explicit approval credits the wallet, in the same
  database transaction that marks the top-up `SUCCEEDED`. A timeout is recorded as `TIMED_OUT`
  with no credit; a reconciliation job against the provider would settle those later.
- **Idempotency.** Send `Idempotency-Key` on `POST /wallet/top-ups` and a retry returns the
  original result (200) instead of charging again. Reusing a key with another amount is a 409.
- **KYC data minimisation.** Only the last four characters of the document number are stored. The
  document itself goes to S3 under `kyc/<userId>/<submissionId>.<ext>`, and its first bytes must
  match the declared type.
- **Logging.** One line per request: method, path, status, duration, request id. Request bodies,
  headers (including `Authorization`), query strings and env values are never logged. Prisma logs
  only warnings and errors, without query parameters. The API suite checks this.

## Database

```sh
npm run prisma:migrate:dev -- --name <change>   # create a migration from schema changes
npm run prisma:migrate:deploy                   # apply pending migrations
```

Every migration folder has a `down.sql` that reverses it. Prisma doesn't write these, so create
one with `npx prisma migrate diff --from-schema <new> --to-schema <old> --script` and end it by
deleting the migration's row from `_prisma_migrations`, as the first one does. To roll back:

```sh
npx prisma db execute --file prisma/migrations/<name>/down.sql
```

After that, `prisma migrate deploy` applies the migration again.

**`binaryTargets`:** set to `["native", "debian-openssl-3.0.x"]`, matching the Docker base image
(Debian 13 "trixie", OpenSSL 3). Change it together with the Dockerfile's `NODE_IMAGE`. With
Prisma 7's Rust-free `prisma-client` generator there is no native query engine, so today the
setting downloads nothing; the API client runs on any Linux image. The Prisma CLI's schema engine
(used only by the `migrate` job) is fetched for whatever platform runs `npm ci`, which in Docker is
the image itself.

## Tests

Use Node 26. NestJS 12 ships as ES modules only, so the test scripts start Jest with
`--experimental-vm-modules` (the app itself needs no flag). There are three layers, each with
its own Jest config:

| Script | Layer | Needs | What it covers |
|---|---|---|---|
| `npm run test:unit` | `test/unit` | nothing | Domain services against in-memory fakes of every port, plus config, adapters and architecture rules. Fails if coverage of `src/domain` drops below 80% (statements, branches, functions or lines). |
| `npm run test:api` | `test/api` | nothing | Every endpoint through supertest on the real Nest app (guard, validation, error filter, multer), with ports swapped for fakes: success paths, 401 for every bad-token case, 403 for top-ups without approved KYC, and validation errors. |
| `npm run test:int` | `test/integration` | Docker, or `TEST_DATABASE_URL` | The Prisma adapters and domain services against a real Postgres, after `prisma migrate deploy` has applied the real migrations. Also checks the migrations themselves: no drift from `schema.prisma`, expected constraints, and `down.sql` round-trips. |
| `npm test` | all three | as above | Runs unit, then API, then integration. |

Code style is checked too: `npm run lint` (ESLint), `npm run typecheck` (tsc) and
`npm run format:check` (Prettier; `npm run format` fixes it). Every pull request runs all of this,
plus the Docker image and API contract checks: see [docs/ci.md](docs/ci.md).

### Domain unit tests

`test/fakes.ts` has an in-memory fake for every port. `FakeKycProvider` and `FakePaymentGateway`
are scripted per call: a result, `'hang'` (never answers, like a dead provider), `{ after, result }`
(answers late) or an `Error` (an outage). Deadlines run on Jest's fake timers, so the timeout paths
are exact and instant. Tests name the rule they protect, so a broken rule reads like this:

```text
Domain rule: only KYC-APPROVED users can top up

RULE BROKEN: expected the call to be refused with KycRequiredError, but it succeeded and returned: …
```

Coverage reports land in `coverage/unit/` (open `lcov-report/index.html`).

### Integration tests

With nothing set, `test:int` starts a throwaway Postgres with
[Testcontainers](https://node.testcontainers.org/), on the same image and digest as
`docker-compose.yml`, and removes it afterwards. Docker must be running.

In CI, or to use a database you already have, set `TEST_DATABASE_URL` and no container is started.
For a GitHub Actions `services: postgres` container, point it at that service. Locally:

```sh
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://wallet:wallet@localhost:5432/wallet npm run test:int
```

Either way the suite applies the migrations first and **empties every table** between tests, so
never point `TEST_DATABASE_URL` at data you care about.

## Docker

The `Dockerfile` has four stages: `build` (all deps, compile), `migrate` (Prisma CLI, used only by
the compose migration job), `prod-deps` (`npm ci --omit=dev`) and `runtime`, which contains only
production dependencies and the compiled app (the base image's npm is removed: nothing uses it at
runtime), runs as the unprivileged `node` user and has a `HEALTHCHECK` on `/health`. Base images are pinned by digest; Dependabot keeps them current.
