# Lypcut backend

API and workers for Lypcut, an AI-native video editor. Node 22, TypeScript (strict), Fastify, Postgres
(Drizzle), BullMQ on Redis, S3-compatible storage (MinIO locally, AWS S3 in production), FFmpeg.

Phase 1 covers accounts, resumable uploads, the processing pipeline (scenes, Hindi/Hinglish/English transcription),
live job status, the reversible timeline API with undo, redo, history and restore, read APIs and OpenTimelineIO export.
Phase 2 adds the AI side: an assistant that turns a chat message into a validated edit, search by meaning, hooks and chapters
found automatically, and the limits and usage records around the model. The front end is the sibling folder `../frontend`. Reference: [API.md](API.md) (and
`/docs` on a running server), [DECISIONS.md](DECISIONS.md) for why things are the way they are.

## How it fits together

```
 Browser (front end)
   │  /api (cookies)            │  PUT parts (presigned, straight to storage)      │  GET video (presigned)
   ▼                            ▼                                                  ▼
 ┌────────────── API (Fastify) ──────────────┐                      ┌── Object storage (S3 / MinIO) ──┐
 │ auth · projects · uploads · timeline ·    │◄──── presigned URLs ─┤ users/<id>/projects/<id>/…      │
 │ content · search · assistant · jobs (+ WS) │                      │  raw · proxy · scenes · thumbs  │
 └──────┬───────────────────┬────────────────┘                      └────────────────▲────────────────┘
        │ SQL               │ BullMQ jobs + pub/sub                                    │ read / write
        ▼                   ▼                                                          │
   Postgres             Redis  ──────────►  Worker (same image, `node dist/worker.js`) ─┘
   (source of truth)    (queues, rate                runs the pipeline: probe → scenes → proxy →
                         limits, live events)         audio → transcribe → embed → hooks → chapters → index →
                                                      timeline → ready
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

| Script                               | What it does                                                  |
| ------------------------------------ | ------------------------------------------------------------- |
| `npm run dev`                        | API with hot reload                                           |
| `npm run worker`                     | Worker with hot reload                                        |
| `npm run build`                      | Compile to `dist/`                                            |
| `npm start`                          | Run the compiled API                                          |
| `npm run db:generate`                | Generate a migration from the Drizzle schema                  |
| `npm run db:migrate`                 | Apply migrations                                              |
| `npm run db:seed`                    | Seed development data                                         |
| `npm test`                           | Unit and integration tests                                    |
| `npm run eval`                       | The assistant's evaluation (see below)                        |
| `npm run models:download-embeddings` | Fetch the search-by-meaning model (Compose does this for you) |
| `npm run lint`                       | ESLint                                                        |
| `npm run typecheck`                  | `tsc --noEmit`                                                |

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

### The assistant

```
POST /api/projects/:id/assistant/messages    { text, playhead, history }      -> text, a question, or an Edit card
POST /api/projects/:id/assistant/answers     { question, optionId, ... }      -> the next question, or the Edit card
POST /api/projects/:id/assistant/reel        { srcFrom, srcTo, title, fast }  -> an Edit card (no model, not counted)
GET  /api/projects/:id/plans                 the Edit cards made so far, with where each one stands
POST /api/projects/:id/plans/:planId/apply   { baseVersion }                  -> a new version by the assistant
GET  /api/me/usage                           the plan and today's assistant allowance
```

The model picks a tool and names things by id; the server builds the op, checks it against a copy of the timeline with the same
engine the editor uses, and only then returns it. See [API.md](API.md#assistant) and, for the reasoning, [DECISIONS.md](DECISIONS.md).

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
the live job feed, Postgres, Redis and object storage, and the language model (below). In production a secret must be set to a real value
(startup refuses the development defaults), `COOKIE_SECURE` defaults on, and `CORS_ORIGINS` cannot be `*`.

### The language model

The assistant, the hooks and the chapters use a language model; search by meaning uses an embedding model. Neither needs an
account to run the product.

| Variable                                                                               | Default                                  | What it does                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`                                                                         | `auto`                                   | `auto` uses Claude when `ANTHROPIC_API_KEY` is set and the built-in offline model otherwise; `anthropic` requires the key; `fake` is always offline     |
| `ANTHROPIC_API_KEY`                                                                    | empty                                    | Claude. Leave empty to run offline                                                                                                                      |
| `LLM_MODEL_PLANNER` / `LLM_MODEL_BATCH`                                                | `claude-sonnet-5-5` / `claude-haiku-5-5` | Chat planning / highlights and chapters                                                                                                                 |
| `LLM_EFFORT_PLANNER` / `LLM_EFFORT_BATCH`                                              | `low`                                    | Speed against care. These models take no temperature                                                                                                    |
| `LLM_MONTHLY_BUDGET_USD`                                                               | `0` (no ceiling)                         | At the ceiling the offline model takes over for the rest of the month (UTC)                                                                             |
| `LLM_BREAKER_FAILURES` / `LLM_BREAKER_COOLDOWN_SEC`                                    | `5` / `60`                               | Provider failures in a row before the offline model takes over, and for how long                                                                        |
| `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_MAX_INPUT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS_*` | see `.env.example`                       | Per-call limits                                                                                                                                         |
| `PLANNER_DAILY_LIMIT`                                                                  | `30`                                     | Assistant requests per person per UTC day (times 5 for creator, 20 for studio)                                                                          |
| `PLANNER_BURST_PER_MINUTE`                                                             | `10`                                     | Assistant requests per person per minute                                                                                                                |
| `EMBEDDING_PROVIDER`                                                                   | `auto`                                   | `local` (multilingual-e5-small, about 120 MB, runs in the API), `hosted` (any OpenAI-compatible `/embeddings`), `fake`; `auto` is local when downloaded |
| `EMBEDDING_MODEL_DIR`                                                                  | `models/embeddings`                      | Where the local model lives (Compose downloads it once)                                                                                                 |

To use Claude: put `ANTHROPIC_API_KEY=…` in `backend/.env` (or the shell) and `docker compose up -d`. To see what it costs,
`GET /api/me/usage` for one person, or sum the `llm_usage` table. Both a model call and its cost are recorded there, with no text.

### What is sent to a model provider

Only when a key (or a hosted embedding service) is configured. With none, nothing leaves your machine.

| Request                                           | Sent to               | What is in it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A chat message                                    | Claude                | The system prompt; one `<data>` block with the video's duration and the edit's state (clip count, caption style, filler and pause counts left), the playhead, the **transcript sentences** (id, speaker label, start and end, text), your language setting (Hindi, Hinglish or English), the highlights and chapters (id, title, times, score) and the caption style names; the last 8 turns of the conversation (600 characters each) and the message (1,000 characters at most, control characters removed) |
| Scoring highlights                                | Claude                | For up to 24 candidate stretches: id, times, cheap signals, pace, filler share and a **transcript excerpt**                                                                                                                                                                                                                                                                                                                                                                                                   |
| Titling chapters                                  | Claude                | For each chapter: index, times and a **transcript excerpt** (700 characters at most)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Embedding (only with `EMBEDDING_PROVIDER=hosted`) | the embedding service | The text of each three-sentence window while a video is processed, and each search query                                                                                                                                                                                                                                                                                                                                                                                                                      |

Never sent: names, email addresses, account details, file names, project titles, video or audio, links to storage. Messages and
replies are not written to the log at info level, and `llm_usage` holds counts and costs only. A saved Edit card's title may repeat a
phrase from the message (a search term, say). The system prompt
tells the model that everything in the data block is material to read, never instructions.

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

## The evaluation

```bash
docker compose up -d postgres redis minio
npm run eval                            # the offline model: free, deterministic, what CI runs
EVAL_PROVIDER=anthropic npm run eval    # Claude (needs ANTHROPIC_API_KEY; a few cents for the whole set)
```

55 prompts in English, Hinglish and Hindi (`eval/golden.ts`) go through the real planner on a real project. The report gives
tool accuracy, outcome accuracy, plan validity, repair rate, latency (p50 and p95), tokens and estimated cost per request, and
lists every miss; a copy is written to `eval/results/`. An invalid plan coming back fails the run whatever else happens. Add a
prompt to `golden.ts` whenever the assistant gets something wrong in real use.

## Not yet

Instagram and style learning (Phase 3), billing, music and YouTube import (music is deliberately never added by the assistant),
MP4 rendering (OTIO export is real), keeping the chat across reloads, Terraform and the AWS deployment itself.
