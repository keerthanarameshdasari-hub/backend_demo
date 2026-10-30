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
| GET | `/users/me` | JWT | The signed-in user, including `kycStatus`. |
| POST | `/kyc` | JWT | Multipart upload: `documentType`, `documentNumber`, `document` (JPEG/PNG/PDF). |
| GET | `/kyc` | JWT | Latest KYC submission. |
| GET | `/wallet` | JWT | Balance. |
| GET | `/wallet/top-ups` | JWT | Recent top-ups, newest first (`?limit=`, max 100). |
| POST | `/wallet/top-ups` | JWT | Top up. Needs approved KYC. Optional `Idempotency-Key` header. |

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
    *.service.ts  UserService, KycService, WalletService.
  adapters/    Implementations of the ports: prisma/, s3/, mock/, system/ (clock, ids, scrypt).
  app/         NestJS wiring. adapters.module.ts is the only place that picks an adapter,
               and it picks only from env config.
  http/        Controllers, DTOs (which also define openapi.json), JWT guard, error mapping,
               request logging.
  config/      Env validation.
  scripts/     generate-openapi, ensure-bucket.
prisma/        Schema and migrations.
test/          unit/ (domain, config, mocks, architecture) and e2e/ (HTTP, in-memory ports).
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
  only warnings and errors, without query parameters. The e2e suite checks this.

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

Use Node 26. NestJS 12 ships as ES modules only; `npm test` starts Jest with
`--experimental-vm-modules` so it can load them (the app itself needs no flag).

```sh
npm test                 # everything (integration tests skip unless TEST_DATABASE_URL is set)
npm run test:unit        # domain, config validation, mocks, architecture rules
npm run test:e2e         # HTTP end to end with in-memory persistence: no Docker needed
npm run test:integration # Prisma adapters against a real, migrated Postgres
```

The integration suite empties the tables it uses, so point it at a throwaway database:

```sh
docker compose up -d postgres migrate
TEST_DATABASE_URL=postgresql://wallet:wallet@localhost:5432/wallet npm run test:integration
```

## Docker

The `Dockerfile` has four stages: `build` (all deps, compile), `migrate` (Prisma CLI, used only by
the compose migration job), `prod-deps` (`npm ci --omit=dev`) and `runtime`, which contains only
production dependencies and the compiled app, runs as the unprivileged `node` user and has a
`HEALTHCHECK` on `/health`. Base images are pinned by digest; Dependabot keeps them current.
