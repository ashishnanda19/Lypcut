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
message if anything is wrong. Every variable is documented in [`.env.example`](.env.example).

See [DECISIONS.md](DECISIONS.md) for choices made along the way.
