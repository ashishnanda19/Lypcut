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

## Agreed with the product owner before building

- Auth tokens travel in httpOnly cookies (SameSite=Lax, Origin check). Bearer tokens are also accepted for
  non-browser clients.
- In real mode the front end keeps using MSW for `/style/*` only (Phase 3).
- The MP4 render stays a stand-in in Phase 1. OTIO export is real.
- The backend lives in its own folder and git repo (`lypcut-backend`), next to the front end.
