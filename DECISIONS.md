# Decisions and assumptions

Each entry records a choice that was not dictated by the brief, and why.

## Step 1: scaffold and local stack

- **MinIO is built from source.** MinIO stopped publishing Docker images (`minio/minio` and `minio/mc`
  are gone from Docker Hub, and Quay now requires authentication). `docker/minio/Dockerfile` builds the
  server from the pinned tag `RELEASE.2025-10-15T17-29-55Z`. The first `docker compose up --build` takes a
  few extra minutes for that; later runs use the cache. The app only speaks the S3 API, so swapping to any
  other S3-compatible server is a change to `docker-compose.yml`, not to code. Production uses AWS S3.
- **No `mc` image.** The bucket is created by `src/tools/ensure-bucket.ts` using the same storage code the
  app uses, run once by the `createbuckets` service.
- **Non-default host ports** (Postgres 5433, Redis 6380) so the stack does not clash with a Postgres or
  Redis already running on a laptop. Inside Docker the services use their normal ports.
- **Two S3 endpoints.** `S3_ENDPOINT` is what the server uses (inside Docker: `http://minio:9000`).
  `S3_PUBLIC_ENDPOINT` is only for signing URLs the browser will call (`http://localhost:9000`). On AWS both
  are unset.
- **API under `/api`, health at the root.** The front end calls relative `/api/...`, so feature routes mount
  under `/api`. `/health`, `/ready` and `/docs` stay at the root where probes and humans expect them.
- **Rate limit counters live in Redis**, so every API instance shares one limit. The limiter uses its own
  fail-fast connection and `skipOnError`, so a Redis blip does not take the API down. Unknown URLs are rate
  limited too (found by a test: the not-found handler is not a normal route).
- **`/ready` fails while draining.** On SIGTERM the API flips `draining`, so load balancers stop routing to
  it before in-flight requests finish.
- **Request ids.** A well-formed `X-Request-Id` from the caller is kept, anything else is replaced. The id is
  on every log line and every response.
- **Empty env values mean unset**, so `TMP_DIR=` in a `.env` file falls back to the default.
- **Plan-limit errors are HTTP 403** with a specific code (`LIMIT_VIDEO_LENGTH`, `LIMIT_MONTHLY_UPLOADS`),
  not 402, which some proxies and clients treat specially.
- **Toolchain matches the front end:** TypeScript 6.0, ESLint 9, Prettier with the same options.

## Step 3: auth and accounts

- **Cookies for browsers, Bearer for everything else.** Browsers get an access token (JWT, HS256, 15 min,
  cookie `lypcut_at`, path `/`) and a refresh token (opaque, 30 days, cookie `lypcut_rt`, path
  `/api/auth` only), both httpOnly and SameSite=Lax, Secure in production. Page scripts cannot read them,
  which matters because the front end stores nothing itself. A non-browser client sends
  `X-Auth-Mode: bearer` and gets the tokens in the response body instead (and a `Bearer` header is always
  accepted). Cookies also work on the jobs WebSocket, where browsers cannot set an `Authorization` header.
- **The access token carries only the user id.** The user is re-read on every request, so a deleted account
  stops working immediately rather than when its token expires, and the plan is never stale. One primary-key
  lookup per request.
- **Refresh tokens rotate and are single use.** Reusing a retired one revokes the whole login (the token
  family), because it may have been stolen. A retired token reused within 10 seconds
  (`REFRESH_REUSE_GRACE_SEC`) is treated as two tabs racing: that request is refused, but the login survives.
  The front end therefore needs one in-flight refresh at a time (Step 9).
- **Only hashes are stored**: SHA-256 of refresh tokens, argon2id of passwords (OWASP minimum cost, rehashed at
  login if the cost is raised). Lookups by hash are followed by a constant-time compare.
- **Login does not reveal which emails exist.** Unknown email and wrong password return the identical response,
  and an unknown email still runs a real password verification so timing matches.
- **Two layers of brute-force protection.** Per IP: signup, login, refresh and Google are limited to 10 a minute
  (`AUTH_RATE_LIMIT_MAX`). Per account: 5 failures lock logins for that email for 15 minutes, counted in Redis
  under a hash of the email (no address in Redis). The trade-off is that someone can deliberately lock another
  person's account for 15 minutes; that is the usual price of per-account lockout and is bounded by the IP limit.
- **Passwords need at least 8 characters** (max 128, to bound hashing cost). The front end currently says 6, so its
  signup validation and copy change in Step 9.
- **CSRF**: on top of SameSite=Lax, every write (POST, PUT, PATCH, DELETE) is refused if its `Origin` is not in
  `CORS_ORIGINS`, or if it has no `Origin` but `Sec-Fetch-Site: cross-site`. Callers with no `Origin` (curl, server to
  server) are not browser-driven and pass.
- **`IdentityProvider` interface.** Password login is one provider. Social login later is a new provider plus a route;
  sessions, tokens and cookies do not change. `POST /auth/google` answers 501 with a clear message until then.
- **`PATCH /me` cannot change the plan.** Billing is simulated and out of scope; unknown fields are ignored.
- **Account deletion** removes every database row in one transaction (the schema cascades from `users`), and
  writes a `delete_account` job in the same transaction, so the promise to delete files cannot be lost. The job
  carries the storage prefix and any multipart uploads still in flight; the worker aborts those (their parts are not
  objects, so deleting the prefix would miss them and storage would keep billing) and then deletes the prefix. The
  worker refuses any prefix that is not exactly a user or project folder.
- **The `jobs` table is the source of truth, BullMQ is the transport.** If an enqueue is lost between commit and add,
  a sweep every minute re-enqueues stale `queued` rows. The BullMQ job id is the row id, so a duplicate add is a no-op.
  The same sweep drops sessions a week past expiry.
- **A JSON `Content-Type` with no body is accepted** (many HTTP clients send it on every request, including DELETE).
  Found by a live smoke test, covered by a regression test.

## Agreed with the product owner before building

- Auth tokens travel in httpOnly cookies (SameSite=Lax, Origin check). Bearer tokens are also accepted for
  non-browser clients.
- In real mode the front end keeps using MSW for `/style/*` only (Phase 3).
- The MP4 render stays a stand-in in Phase 1. OTIO export is real.
- The backend lives in its own folder and git repo (`lypcut-backend`), next to the front end.
