# Lypcut backend

API and workers for Lypcut, an AI-native video editor. Node 22, TypeScript (strict), Fastify, Postgres
(Drizzle), BullMQ on Redis, S3-compatible storage (MinIO locally, AWS S3 in production), FFmpeg.

Phase 1 covers accounts, resumable uploads, the processing pipeline (scenes, Hindi/Hinglish/English transcription),
live job status, the reversible timeline API with undo, redo, history and restore, read APIs and OpenTimelineIO export.
Phase 2 adds the AI side: an assistant that turns a chat message into a validated edit, search by meaning, hooks and chapters
found automatically, and the limits and usage records around the model.
Phase 3 teaches the assistant a creator's own style: it learns how soon their best Reels start, how often they cut and which caption look
they use, from Instagram (Meta's official API, read-only) or from Reels they upload by hand, and then edits "in my style". The front end is
the sibling folder `../frontend`. Reference: [API.md](API.md) (and `/docs` on a running server), [DECISIONS.md](DECISIONS.md) for why things
are the way they are, [docs/meta-review.md](docs/meta-review.md) for getting the Instagram connection approved by Meta.

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
- **Style is learned, not copied.** A creator's Reels become numbers and style ids (a profile), never stored content. Code does the
  measuring; a model only labels what the rules could not place and puts a few figures into one sentence. The assistant only ever
  proposes timeline ops, and the server validates them. See [Style](#style-teaching-lypcut-your-own-way-of-editing).
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

**It needs no account and no key.** With no Meta app, Instagram is a built-in stand-in (a fake consent screen and fixture Reels, outside
production only); with no `ANTHROPIC_API_KEY` the assistant, captions labelling and style sentence run on the built-in offline model.
Both are for trying the product; real Instagram needs the Meta app in [docs/meta-review.md](docs/meta-review.md).

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

| Script                               | What it does                                                     |
| ------------------------------------ | ---------------------------------------------------------------- |
| `npm run dev`                        | API with hot reload                                              |
| `npm run worker`                     | Worker with hot reload                                           |
| `npm run build`                      | Compile to `dist/`                                               |
| `npm start`                          | Run the compiled API                                             |
| `npm run db:generate`                | Generate a migration from the Drizzle schema                     |
| `npm run db:migrate`                 | Apply migrations                                                 |
| `npm run db:seed`                    | Seed development data                                            |
| `npm test`                           | Unit and integration tests                                       |
| `npm run eval`                       | The assistant's evaluation (see below)                           |
| `npm run jobs:dead`                  | List jobs that used up every try; `-- retry <id>` runs one again |
| `npm run models:download-embeddings` | Fetch the search-by-meaning model (Compose does this for you)    |
| `npm run lint`                       | ESLint                                                           |
| `npm run typecheck`                  | `tsc --noEmit`                                                   |

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
the live job feed, Style (Instagram, token encryption, limits; below), Postgres, Redis and object storage, and the language model (below). In production a secret must be set to a real value
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

Only when a key (or a hosted embedding or speech service) is configured. With none, nothing leaves your machine. This is the complete list: nothing
else is sent, and the code that builds each request is named so it can be checked.

| Request                                                                        | Sent to               | What is in it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A chat message                                                                 | Claude                | The system prompt; one `<data>` block with the video's duration and the edit's state (clip count, caption style, filler and pause counts left), the playhead, the **transcript sentences** (id, speaker label, start and end, text), your language setting (Hindi, Hinglish or English), the highlights and chapters (id, title, times, score) and the caption style names; the last 8 turns of the conversation (600 characters each) and the message (1,000 characters at most, control characters removed) |
| A chat message with **Apply my style** on (`src/planner/context.ts`)           | Claude                | The above plus a `myStyle` block: up to three caption look ids, cuts per 10 seconds, hook timing in seconds, the confidence word (`low`, `medium`, `high`) and the one-sentence summary. With the switch off, the model is not shown the profile: asking to "match my style" makes it pick a tool, and the server applies the profile itself                                                                                                                                                                  |
| Scoring highlights                                                             | Claude                | For up to 24 candidate stretches: id, times, cheap signals, pace, filler share and a **transcript excerpt**                                                                                                                                                                                                                                                                                                                                                                                                   |
| Titling chapters                                                               | Claude                | For each chapter: index, times and a **transcript excerpt** (700 characters at most)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Labelling a Reel's captions (`src/style/analysis/vision.ts`)                   | Claude                | **Only for Reels whose captions the colour and shape rules could not place.** Up to 4 small still pictures (JPEG, 360 pixels wide) from each such Reel, and up to 12 Reels per call, each tagged with an internal id and the number of pictures. The pictures show whatever is on screen in those moments, so they can include a face or on-screen text. No transcript, audio, numbers or names                                                                                                               |
| Writing the style sentence (`src/style/analysis/summary.ts`)                   | Claude                | Seven figures and nothing else: your language setting, hook timing, seconds between cuts, cuts per 10 seconds, the name of your most used caption look, how many Reels it comes from, and the confidence word. The reply is used only if every number in it is one of those figures                                                                                                                                                                                                                           |
| Speech recognition (only with `TRANSCRIPTION_PROVIDER=openai` or `assemblyai`) | that service          | The **audio** of each video, and of each Reel you upload for Style. The default, `whisper-local`, runs on your machine and sends nothing                                                                                                                                                                                                                                                                                                                                                                      |
| Embedding (only with `EMBEDDING_PROVIDER=hosted`)                              | the embedding service | The text of each three-sentence window while a video is processed, and each search query                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Never sent to any model provider:** names, email addresses, account details, file names, project titles, links to storage; your Instagram handle,
account id or access token; any Reel's numbers (views, likes, saves, shares, watch time); Instagram captions, comments, followers or messages; any
Reel's video file or its transcript. The Reels' numbers are used only by code, to decide which Reels were your best. Messages and replies are not
written to the log at info level, and `llm_usage` holds counts and costs only (its `kind` for Style is `style`). A saved Edit card's title may repeat
a phrase from the message (a search term, say). The system prompts tell the model that everything in the data block, and everything in a
picture, is material to read or look at, never instructions.

## Style: teaching Lypcut your own way of editing

Style turns a creator's best Reels into a small **profile**: how soon the hook lands (seconds), how often they cut (cuts per 10 seconds),
their speech rate, which caption look they use, and one sentence saying so. The assistant then edits "in my style": say _match my style_,
_meri style lagao_, or turn on **Apply my style**, and captions, pacing and Reels follow the profile. Nothing is applied until the person
presses Apply, and every change is one undoable step, like any other edit.

```
 Instagram (official API,      Upload Reels by hand
 Instagram Login, read-only)   (up to 10, up to 90 s each, optional numbers)
        │ ids, dates, numbers           │ video files (deleted after they are measured)
        ▼                               ▼
     reels · reel_metrics  ──►  analysis worker (queue "style")  ──►  reel_analysis ──► style_profiles ──► assistant
                                 code measures; a model only labels                      (numbers and ids)   (match_my_style)
                                 ambiguous captions and writes one sentence
```

**Manual upload is a full path, not a fallback.** Instagram is optional. A personal Instagram account cannot be read by Meta's API (only
Creator and Business accounts can), so the Style page says _Switch to a Creator account, it is free_ and offers the upload instead.
Connected Instagram alone gives numbers but no video files, so it can rank the Reels and not describe them: the page then asks for the files
of the best few (`needs: "reel_files"`), and the profile is built from those.

### How a profile is made

| Step                    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rank the Reels          | Each signal is turned into a rate (saves, shares, comments and likes **per view**, and average watch share) and ranked among **that creator's own** Reels, so a small account is not compared with a large one. The ranks are averaged with the weights in `src/style/analysis/config.ts`: **watch share 0.35, saves 0.25, shares 0.25, comments 0.10, likes 0.05**. Watch time, saves and shares weigh most because they need effort or attention; a like costs one tap. A missing signal is left out of that Reel's average, never counted as 0. A Reel needs at least two signals, 100 views and 3 days of age to be scored. |
| Pick the winners        | The best third (at least three), weighted by score. With fewer than three scored Reels they all count equally and the profile says it is a first guess (`confidence: "low"`; `medium` from 5 Reels with 3 sets of numbers, `high` from 10 with 8).                                                                                                                                                                                                                                                                                                                                                                              |
| Measure                 | FFmpeg and the speech recogniser (not a model) give hook timing (the earlier of the first word and the first strong cut), cut pace, speech rate, and the colours and shape of the caption area in six frames.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Label what is unclear   | Caption looks that the colour and shape rules place are labelled by code. For the rest, **one** batched call shows a model a few small stills and asks it to choose from the editor's closed list; anything outside the list becomes `custom`.                                                                                                                                                                                                                                                                                                                                                                                  |
| Write one sentence      | A model is given seven figures and asked to say them in words. The sentence is accepted only if every number in it is one of those figures; otherwise the profile has no sentence and is complete without one (the built-in offline model writes a fixed template sentence).                                                                                                                                                                                                                                                                                                                                                    |
| Keep numbers, not video | The video is deleted once measured. The thumbnail and the numbers stay, so the page can show the Reel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Connecting Instagram

`POST /api/style/connect` returns what the person is told before they go (what is read, what is never done), then sends them to Instagram's
consent screen. Lypcut asks for exactly two read-only permissions, `instagram_business_basic` and `instagram_business_manage_insights`, and
never requests anything that posts, comments or messages. The return address is the backend (`INSTAGRAM_REDIRECT_URI`), protected by a
single-use state (hashed in the database, bound to the person, valid ten minutes), and always redirects to the Style page, which says what
happened (connected, cancelled, personal account, expired, Instagram unavailable).

| You have                                                    | Set                                                                                      | You get                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Nothing (the default)                                       | nothing                                                                                  | The stand-in: a fake consent screen and fixture Reels. Not in production.                                   |
| A Meta app (see [docs/meta-review.md](docs/meta-review.md)) | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` (all three or none) | The real Instagram. People with a role on the app can connect before Meta's review; everyone else after it. |

**Tokens** are sealed with AES-256-GCM before they reach the database (`v1.<key id>.<nonce>.<ciphertext>`, with the key id and the owner
authenticated, so a copied row does not open for another person). Development and tests use a public built-in key; production refuses to
start without `TOKEN_ENCRYPTION_KEY`. To rotate, put the new key (with a new id) in `TOKEN_ENCRYPTION_KEY` and the old one in
`TOKEN_ENCRYPTION_OLD_KEYS`; old rows still open, and each is sealed with the new key when its token is next renewed. Tokens, authorisation codes and states are never
returned by the API and never logged (request logs keep the path, not the query string).

**Keeping it fresh.** A daily scheduler reads every connected account about weekly (6 days since the last read, so a worker that was down
for a day still catches up) and renews each token well before its 60 days end. A person can refresh by hand once an hour. If Instagram stops
accepting the token, the account moves to `reauth_required`: the page says **Reconnect** and keeps showing the last good profile.

### Consent, and taking it all back

Connecting is explicit and disconnecting is real. `DELETE /api/style/connect` deletes the stored token, the connection, every Reel,
its numbers and analysis, and the profile, in **one database transaction before it returns**; the uploaded videos and thumbnails (storage)
are deleted by a job straight after (`users/<id>/style/` is one prefix). Removing Lypcut from Instagram's settings reaches the same code
through **Meta's data-deletion callback** (`POST /api/privacy/instagram/deletion`): the signed request is verified (HMAC-SHA256 against the
app secret, constant-time compare, form posts only) and anything unverifiable gets a bare 403. The answer carries a confirmation code and a
status address (`GET /api/privacy/instagram/deletion?code=…`). The public privacy policy Meta requires is served at `/api/privacy`; it needs
`LEGAL_ENTITY_NAME` and `PRIVACY_CONTACT_EMAIL`, and a lawyer's review before launch.

### Limits

| What                                        | Free (same for every plan today)                  | Where it is set                      |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| Reels uploaded by hand at once              | 10 (`LIMIT_STYLE_REELS`)                          | `STYLE_LIMITS` in `src/lib/plans.ts` |
| Length of one Reel                          | 90 seconds, checked from the file                 | `STYLE_LIMITS` in `src/lib/plans.ts` |
| Size of one Reel file                       | 300 MB                                            | `STYLE_MAX_REEL_BYTES`               |
| Instagram Reels read in one sync            | the newest 30                                     | `STYLE_MAX_REELS`                    |
| Refreshing from Instagram by hand           | once an hour per person                           | `STYLE_SYNC_COOLDOWN_SEC`            |
| Style actions that change something         | 20 a minute per person (public callbacks: per IP) | `STYLE_RATE_LIMIT_PER_MIN`           |
| Style learning does not use project uploads | it never counts against the 3 a month             |                                      |

### When something goes wrong

- **Rate limits.** Besides the whole-API limit (300 a minute per IP), every Style action that changes something is limited per person
  (see above), and the two public addresses Instagram and Meta call are limited per IP. A limited request is a `429 RATE_LIMITED` with `Retry-After`.
- **Instagram slowing us down.** Calls are spaced (`STYLE_IG_CALL_INTERVAL_MS`), the sync slows itself when Instagram's usage headers
  say most of the allowance is used, and a call that is rate-limited waits for `Retry-After` (at most five minutes), while a briefly
  unavailable one is retried after 1, 2 and 4 seconds, each with jitter. A token Instagram rejects is not retried; it ends in Reconnect.
- **Jobs.** A style job that still fails is retried by the queue up to `JOB_ATTEMPTS` (5) times, waiting `STYLE_JOB_BACKOFF_MS` (30 s) and
  doubling each time. Analysis picks up where it stopped, so a retry measures only the Reels still left; a Reel that cannot be measured
  (too long, no speech, not a video) is marked failed on its own row, with a reason the person can act on, and does not fail the job.
- **Dead letters.** A job that used up every try stays in the queue's failed set and its `jobs` row says `failed`, with a plain sentence
  and a code (`ANALYSIS_FAILED`, `SYNC_FAILED`, `REFRESH_FAILED`, `DELETION_FAILED`) and never the underlying error. List them with
  `npm run jobs:dead` (in Docker: `docker compose exec worker node dist/tools/dead-letters.js`), and, once whatever broke them is fixed,
  run one again with `npm run jobs:dead -- retry <job id>`. Deletion jobs are the ones to watch: a stuck one means files are still in storage.
- **A lost queue message.** The jobs table is the source of truth and a sweep puts any job still `queued` after a minute back on the queue.

### Trying it in three minutes

You need five short Reels or phone videos of yourself talking (any length up to 90 seconds; Hindi, Hinglish or English). Learning takes
one to two minutes a Reel in Docker on a laptop (three Reels took just under four minutes in the clean-room run), because speech recognition runs on your CPU, so **do steps 1 to 3 before the demo** and leave the page open.

```bash
docker compose up -d                                   # in backend/
cd ../frontend && echo "VITE_API_MODE=real" > .env.local && npm install && npm run dev   # http://localhost:5173
```

| Time | You say or do                                                                                                                     | What the audience sees                                                                                                                         | Say                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0:00 | Open **Style** (already learned: before the demo, sign up, upload your five Reels, paste their numbers, click **Learn my style**) | "Learned from uploaded Reels · 5 Reels analysed": hook timing, cut pace, caption look, one sentence, the Reels with their pictures and numbers | "It watched my five best Reels and measured them. These are numbers, not copies."                   |
| 0:30 | Point at **Hook lands at**, **Cut pace** and **Captions you use**; scroll to **Your top Reels**                                   | Each Reel with its picture, its numbers (a dash where there are none) and a remove button                                                      | "No video is kept. If I remove a Reel, the profile is worked out again."                            |
| 1:00 | Click **Connect Instagram**                                                                                                       | A page saying exactly what is read and what is never done (post, comment, message, change anything)                                            | "Nothing happens until I say so, and I can take it all back." Click Cancel: "That is not an error." |
| 1:20 | Open a finished project, type **`match my style`** (or **`meri style lagao`**)                                                    | An Edit card: "Using your … style", with what it will change (captions, pauses) and what it kept                                               | "It proposes. It does not touch the video."                                                         |
| 1:50 | Click **Preview**, then **Apply**                                                                                                 | The edit lands; **History** shows a version by the assistant                                                                                   | "One labelled step."                                                                                |
| 2:15 | Click **Undo**                                                                                                                    | The project is exactly as before                                                                                                               | "And it is gone."                                                                                   |
| 2:30 | Back on **Style**, click **Disconnect**                                                                                           | The page returns to the start; `GET /api/style` says `connected: false`; the Reels are gone                                                    | "Disconnecting deletes the Reels, the numbers and the style. It is not a hide button."              |

Without a key the assistant is the built-in offline model, which understands the phrases above. To try Instagram itself on the stand-in,
click **Connect Instagram**, **Continue to Instagram**, then **Continue as a Creator account** (fixture Reels appear), or **Continue as a
personal account** to see why that one is turned away.

### What Style stores, and what it never does

Stored: Instagram account id, handle, the sealed token, and for each Reel its id, date, numbers and measured analysis (timing, cuts,
caption look, fonts, colours as hex codes), a thumbnail, and the profile. **Never stored or requested:** captions or comments from Instagram, other
people's names or content, followers, messages, a download of any Instagram video, or anything that writes to Instagram. The only
videos the backend ever holds are the ones the creator uploaded, for as long as it takes to measure them.

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

69 prompts in English, Hinglish and Hindi (`eval/golden.ts`) go through the real planner on a real project. The report gives
tool accuracy, outcome accuracy, plan validity, repair rate, latency (p50 and p95), tokens and estimated cost per request, and
lists every miss; a copy is written to `eval/results/`. An invalid plan coming back fails the run whatever else happens. Add a
prompt to `golden.ts` whenever the assistant gets something wrong in real use.

## Not yet

Billing, music and YouTube import (music is deliberately never added by the assistant), TikTok and YouTube as style sources, MP4
rendering (OTIO export is real), keeping the chat across reloads, Terraform and the AWS deployment itself. Instagram has been exercised
only against the built-in stand-in until a Meta app and a test account exist (see [Style](#style-teaching-lypcut-your-own-way-of-editing)).
