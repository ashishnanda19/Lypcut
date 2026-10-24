# Lypcut backend

API and workers for Lypcut, an AI-native video editor. Node 22, TypeScript (strict), Fastify, Postgres
(Drizzle), BullMQ on Redis, S3-compatible storage (MinIO locally, AWS S3 in production), FFmpeg.

Phase 1 covers accounts, resumable uploads, the processing pipeline (scenes, Hindi/Hinglish/English transcription,
hooks and chapters), live job status, the reversible timeline API with undo, redo, history and restore, read APIs and
search, and OpenTimelineIO export. The front end is the sibling folder `../frontend`. Reference: [API.md](API.md) (and
`/docs` on a running server), [DECISIONS.md](DECISIONS.md) for why things are the way they are.

## How it fits together

```
 Browser (front end)
   │  /api (cookies)            │  PUT parts (presigned, straight to storage)      │  GET video (presigned)
   ▼                            ▼                                                  ▼
 ┌────────────── API (Fastify) ──────────────┐                      ┌── Object storage (S3 / MinIO) ──┐
 │ auth · projects · uploads · timeline ·    │◄──── presigned URLs ─┤ users/<id>/projects/<id>/…      │
 │ content · search · jobs (+ WebSocket)     │                      │  raw · proxy · scenes · thumbs  │
 └──────┬───────────────────┬────────────────┘                      └────────────────▲────────────────┘
        │ SQL               │ BullMQ jobs + pub/sub                                    │ read / write
        ▼                   ▼                                                          │
   Postgres             Redis  ──────────►  Worker (same image, `node dist/worker.js`) ─┘
   (source of truth)    (queues, rate                runs the pipeline: probe → scenes → proxy →
                         limits, live events)         audio → transcribe → index → timeline → ready
```

- **Postgres is the source of truth** for everything that matters (accounts, projects, jobs, transcripts, timelines
  and every version of them). Redis holds only what can be rebuilt: queues, rate-limit counters, live events.
- **Video bytes never pass through the API.** Uploads and playback use short-lived links signed for one object.
- **The worker runs the pipeline** as checkpointed, idempotent stages. A crash or a restart resumes at the stage that
  was running; a permanent failure is a clear message on the job, and **Retry** continues from there.
- **The timeline engine is one shared package** (`packages/timeline-core`), used by the editor and the server, so an
  edit gives the same result in both, ids included.
- **Every query that touches user data is scoped by owner**, in the `WHERE` clause. Another person's project is a `404`,
  never a `403`. A table-driven test lists every route and must grow with each new one.

## Run everything

```bash
docker compose up --build
```

The first build also compiles MinIO and whisper.cpp from source (a few minutes, once), and the first start downloads
the speech model (~465 MB for `small`) into a volume. Then:

| What                 | Where                                                |
| -------------------- | ---------------------------------------------------- |
| API                  | http://localhost:4000                                |
| Liveness / readiness | `/health`, `/ready`                                  |
| OpenAPI docs         | http://localhost:4000/docs                           |
| MinIO console        | http://localhost:9001 (lypcut / lypcut-local-secret) |
| Postgres             | `localhost:5433` (lypcut / lypcut)                   |
| Redis                | `localhost:6380`                                     |

The credentials above are local-development defaults only.

To use it from the front end: `cd ../frontend && echo "VITE_API_MODE=real" > .env.local && npm run dev`
(`http://localhost:5173` is in `CORS_ORIGINS` by default).

**First run with real recordings.** The default model (`small`) handles Hinglish well enough to build the product on,
but try real creator audio before launch and consider `WHISPER_MODEL=medium` for Hindi. Roman to Devanagari is exact
only for words in the lexicon; hooks and chapters are heuristic until the Phase 2 language model.

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

## What happens after an upload

The worker runs eight stages per project and reports each on the job (`step`, `detail`, `progress`, `found`):

| Stage         | Step                           | What it does                                                          |
| ------------- | ------------------------------ | --------------------------------------------------------------------- |
| `probe`       | 1 Splitting into clips         | Streams the original down, hashes it, checks it with ffprobe          |
| `scenes`      | 1                              | Finds picture cuts and silences, splits long shots, makes thumbnails  |
| `split_proxy` | 1                              | One clip per scene (stream copy when possible) and one 540p proxy     |
| `audio`       | 2 Transcribing                 | Mono 16 kHz WAV for speech recognition                                |
| `transcribe`  | 2                              | Speech to words (both scripts, per-word language, fillers, sentences) |
| `index`       | 3 Indexing scenes and speakers | Hook candidates, chapters, scene names                                |
| `timeline`    | 3                              | The first multi-track timeline (version 0)                            |
| `ready`       | 4 Ready                        | Marks the project ready                                               |

Each stage is checkpointed and idempotent, so a failed job resumes at the stage that failed.

### Reading a project

```
GET /api/projects/:id/transcript[?from=&to=]   words (Roman + Devanagari), speakers, sentences
GET /api/projects/:id/scenes | highlights | chapters
GET /api/projects/:id/search?q=funding&limit=8   find moments (Roman, Devanagari, whole sentences, misspellings)
GET /api/projects/:id/summary
GET /api/projects/:id/assets[?kind=]             files with short-lived links
GET /api/projects/:id/assets/:assetId/url        a fresh link for one file
```

A project that is still processing answers `409 NOT_READY`. Video bytes never pass through the API: files are presigned links
(or CDN links once `CDN_BASE_URL` is set).

### Editing the timeline

```
GET  /api/projects/:id/timeline              { version, lastVersion, canUndo, canRedo, timeline }
POST /api/projects/:id/timeline/ops          { baseVersion, ops: [...], label, author?, editId? }  -> one new version
POST /api/projects/:id/timeline/undo|redo    { baseVersion }
GET  /api/projects/:id/timeline/history      versions without snapshots (?limit=&before=)
GET  /api/projects/:id/timeline/versions/:n  one version in full
POST /api/projects/:id/timeline/restore      { baseVersion, versionN }  -> a new version equal to that one
GET  /api/projects/:id/export/otio           the current timeline as an OpenTimelineIO file
```

Always send back the `version` you last saw as `baseVersion`; a stale one is a `409 VERSION_CONFLICT`. An invalid op is a
`422 INVALID_OP` that names the op. The engine lives in `packages/timeline-core` (shared with the front end) and has no I/O; the server adds the strict op schema and OTIO export in `src/timeline-core`.

### Following a job

```
GET  /api/jobs/:id            current state (polling fallback)
POST /api/jobs/:id/retry      retry a failed job from the stage that failed
GET  /api/jobs/ws             WebSocket: send {"type":"subscribe","jobId":"..."}
                              receive {"type":"job","job":{...}}   (a full snapshot every time)
                                   or {"type":"error","jobId":"...","message":"Unknown job"}
```

The socket authenticates with the login cookie and must come from an origin in `CORS_ORIGINS`. After a reconnect, subscribe
again: the first message is the current state.

### Speech recognition

`TRANSCRIPTION_PROVIDER` picks the engine: `whisper-local` (default, no account), `openai` or `assemblyai` (needs a key;
AssemblyAI also separates speakers). Hindi and Hinglish both use the Hindi model.

**Docker** needs nothing: the image builds whisper.cpp and `docker compose up` downloads the model (465 MB for `small`) into a
volume the first time. Pick a different size with `WHISPER_MODEL=tiny|base|small|medium`.

**On your machine** (running `npm run worker` yourself):

```bash
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp .tools/whisper.cpp
cmake -S .tools/whisper.cpp -B .tools/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build .tools/whisper.cpp/build -j --target whisper-cli
npm run models:download        # ./models/ggml-small.bin
# in .env:  WHISPER_BIN=.tools/whisper.cpp/build/bin/whisper-cli
```

The tests that use real Whisper and real speech (macOS voices) run when those three are present and skip otherwise.
`npm run fixtures` writes a small sample video to `test/fixtures/sample.mp4`.

## Configuration

Everything comes from environment variables, validated at startup. The process exits with a clear
message if anything is wrong. Every variable is documented, with its default, in [`.env.example`](.env.example);
the groups are Process, HTTP (CORS, rate limits), Auth (secrets, token lifetimes, lockout), Uploads and media
(limits, part size, link lifetimes), Transcription (provider and its keys), Processing (retries, scene detection),
the live job feed, Postgres, Redis and object storage. In production a secret must be set to a real value
(startup refuses the development defaults), `COOKIE_SECURE` defaults on, and `CORS_ORIGINS` cannot be `*`.

## Security in short

Passwords are hashed with argon2id; refresh tokens are stored only as hashes, rotate on every use and a reused one ends
the login. Cookies are httpOnly and SameSite=Lax, and every browser write must come from an allowed `Origin`. Logins are
rate limited per IP and per account (without revealing which emails exist). Uploads are validated by content with ffprobe,
never by file name or the client's claimed type or duration. Download and upload links expire and are signed for one
object. Every query is scoped by owner. Request bodies are validated with Zod (timeline ops refuse unknown fields outright). Logs carry
request ids, and credentials and email addresses are redacted at the logger. No secret is in the repository.

## Going to production on AWS

Nothing is AWS-specific in the code; each local service maps onto a managed one by configuration.

| Local (Compose)    | AWS                           | Notes                                                                                                                                                                                                   |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`         | **RDS for PostgreSQL** 16+    | Needs the `pg_trgm` extension (created by the migration). Set `DATABASE_URL`.                                                                                                                           |
| `redis`            | **ElastiCache for Redis**     | Set `REDIS_URL`. Use a non-cluster primary with `maxmemory-policy noeviction` (BullMQ requirement).                                                                                                     |
| `minio`            | **S3**                        | Leave `S3_ENDPOINT` empty, `S3_FORCE_PATH_STYLE=false`, leave the keys empty to use the task role.                                                                                                      |
| `api`              | **ECS Fargate** service       | Behind an ALB; `TRUST_PROXY=true`; health check `GET /health`, readiness `GET /ready`. The live job feed is a WebSocket; the server pings every 30 s, so the ALB's default 60 s idle timeout is enough. |
| `worker`           | **ECS Fargate** service       | Same image, command `node dist/worker.js`. Scale on queue depth. Give it enough ephemeral storage for video work (`TMP_DIR`).                                                                           |
| presigned S3 links | **CloudFront** in front of S3 | Set `CDN_BASE_URL`; CloudFront signing slots into `Storage.presignGet`. Presigned S3 URLs work without it.                                                                                              |
| env file           | **Secrets Manager / SSM**     | `AUTH_ACCESS_SECRET`, `DATABASE_URL`, provider API keys.                                                                                                                                                |

Two bucket settings are needed on S3 (and MinIO already behaves this way locally):

1. **CORS**, so the browser can send parts directly:

   ```json
   [
     {
       "AllowedOrigins": ["https://app.example.com"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

2. **A lifecycle rule that aborts incomplete multipart uploads** (for example after 2 days), as a safety net under the
   API's own sweep, so abandoned parts are never billed indefinitely:

   ```json
   {
     "Rules": [
       {
         "ID": "abort-incomplete",
         "Status": "Enabled",
         "Filter": {},
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 }
       }
     ]
   }
   ```

The worker needs `ffmpeg`, `ffprobe` and (for local transcription) the `whisper-cli` binary, all in the Docker image.
For hosted transcription set `TRANSCRIPTION_PROVIDER=openai` or `assemblyai` and the matching key; no binary or model is needed.

## Not in Phase 1

The language-model assistant (the front end's planner still runs in the browser), Instagram and style learning, billing,
music and YouTube import, MP4 rendering (OTIO export is real), Terraform and the AWS deployment itself.
