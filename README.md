# Lypcut backend

API and workers for Lypcut, an AI-native video editor. Node 22, TypeScript (strict), Fastify, Postgres
(Drizzle), BullMQ on Redis, S3-compatible storage (MinIO locally, AWS S3 in production), FFmpeg.

> Phase 1 is being built step by step. This README grows with each step.

## Run everything

```bash
docker compose up --build
```

The first build also compiles MinIO from source (a few minutes, once). Then:

| What                 | Where                                                |
| -------------------- | ---------------------------------------------------- |
| API                  | http://localhost:4000                                |
| Liveness / readiness | `/health`, `/ready`                                  |
| OpenAPI docs         | http://localhost:4000/docs                           |
| MinIO console        | http://localhost:9001 (lypcut / lypcut-local-secret) |
| Postgres             | `localhost:5433` (lypcut / lypcut)                   |
| Redis                | `localhost:6380`                                     |

The credentials above are local-development defaults only.

## Develop on your machine

Run just the infrastructure in Docker, and the API and worker with hot reload:

```bash
docker compose up -d postgres redis minio createbuckets
cp .env.example .env
npm install
npm run db:migrate
npm run dev        # API on :4000
npm run worker     # worker
```

## Scripts

| Script                | What it does                                 |
| --------------------- | -------------------------------------------- |
| `npm run dev`         | API with hot reload                          |
| `npm run worker`      | Worker with hot reload                       |
| `npm run build`       | Compile to `dist/`                           |
| `npm start`           | Run the compiled API                         |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:migrate`  | Apply migrations                             |
| `npm run db:seed`     | Seed development data                        |
| `npm test`            | Unit and integration tests                   |
| `npm run lint`        | ESLint                                       |
| `npm run typecheck`   | `tsc --noEmit`                               |

## Tests

Unit tests need nothing. Integration tests use real Postgres, Redis and MinIO from the Compose stack,
with their own database (`lypcut_test`), Redis db (1) and bucket (`lypcut-test`):

```bash
docker compose up -d postgres redis minio
npm test
```

## Auth in one minute

`POST /api/auth/signup` and `/login` set two httpOnly cookies (access, refresh). `POST /api/auth/refresh` rotates
them, `POST /api/auth/logout` ends the login, `GET/PATCH/DELETE /api/me` read, update and delete the account. Send
`X-Auth-Mode: bearer` to get tokens in the response body instead (for scripts and mobile apps).

## Uploading a video

```
POST /api/projects              { fileName }                     -> project (status "uploading")
POST /api/uploads               { projectId, fileName, sizeBytes } -> upload { id, partSize, totalParts }
POST /api/uploads/:id/parts     { partNumbers: [1,2,3] }          -> presigned URLs; PUT each part to storage
GET  /api/uploads/:id                                             -> which parts storage holds (to resume)
POST /api/uploads/:id/complete  { checksum? }                     -> project "processing" + job
DELETE /api/uploads/:id                                           -> abort
```

The free plan allows 10 minutes per video and 3 uploads a month (`src/lib/plans.ts`). Over-limit files are
refused with `LIMIT_VIDEO_LENGTH` or `LIMIT_MONTHLY_UPLOADS` before any processing is paid for.

## Configuration

Everything comes from environment variables, validated at startup. The process exits with a clear
message if anything is wrong. Every variable is documented in [`.env.example`](.env.example).

See [DECISIONS.md](DECISIONS.md) for choices made along the way.
