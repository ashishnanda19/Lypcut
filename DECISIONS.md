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

## Step 4: projects and resumable uploads

- **Create the project, then upload into it.** `POST /projects` makes an empty project (status `uploading`), then
  `POST /uploads` starts the transfer. The front end's mock did the opposite (a timer, then create), so
  `NewProjectPage` changes in Step 9. The response of `POST /projects` is `{ project }`; the job arrives with
  `POST /uploads/:id/complete`, which is when processing actually starts.
- **Video bytes never touch the API.** The client sends each part straight to storage with a presigned URL
  (signed for exactly one object, one part and one verb; a GET on it is refused). The API only coordinates.
- **Storage is the source of truth for what arrived.** `GET /uploads/:id` asks storage which parts it holds and
  returns them, so a client that closed its tab sends only what is missing. Starting the same file again resumes
  the open upload (HTTP 200) instead of opening a second.
- **Completing checks four things, in order:** every part is present and the right size (fixable by the client, so
  nothing is discarded); the stitched object is the declared size; an optional SHA-256 matches (streamed, so memory
  stays flat); then ffprobe reads the file. Refusals about the file itself (not a video, too long, bad checksum)
  delete the object and mark the upload failed, but the project stays waiting so the user can try another file.
  An infrastructure error leaves the object and reverts the upload to `uploading` so `complete` can be retried.
- **Validated by content, not by name.** The extension and declared type are an early filter only. ffprobe, run over a
  presigned URL (so only the header is read, not the whole file), decides: the container must be MP4/MOV, Matroska/WebM
  or AVI, with a real video stream (cover art does not count). A PNG renamed `.mp4`, random bytes and audio-only files
  are all refused. ffprobe runs as a child process with a 30 s timeout and a capped output size.
- **Plan limits come from one `PLANS` object** (`src/lib/plans.ts`), not from the code that enforces them.
  Free is 10 minutes and 3 uploads a month. Length is checked on the measured duration; the client-reported duration
  is used only for a fast early refusal. A 1 second tolerance keeps a "10 minute" file that measures 600.04 s inside the limit.
- **"Per month" means calendar month, UTC.** An upload counts when it is accepted, not when it starts, so a refused or
  abandoned upload does not use up the allowance. In-flight uploads are counted too, and starts are serialised per
  user with a Postgres advisory lock, so two tabs cannot both slip under the limit.
- **Errors the front end can show:** `LIMIT_VIDEO_LENGTH` (details `maxSeconds`, `durationSec`) and
  `LIMIT_MONTHLY_UPLOADS` (details `max`), both HTTP 403, plus `UNSUPPORTED_MEDIA` 415, `PAYLOAD_TOO_LARGE` 413,
  `UPLOAD_INCOMPLETE` 422 (details `missing`, `wrongSize`), `CHECKSUM_MISMATCH` 422, `UPLOAD_EXPIRED` 410.
- **Ownership lives in the query.** Lookups put the owner in the `WHERE` clause (`src/lib/ownership.ts`), so another
  user's rows are never fetched, and the answer is 404, identical to "does not exist", so ids cannot be probed. A table-driven
  test lists every route and must grow with each new one.
- **The project payload is deliberately small.** `assets` holds the original and the proxy only (not one entry per scene
  clip), and only the proxy has a URL. URLs last an hour (`PRESIGN_GET_TTL_SEC`); a long editing session may need a fresh one,
  which is why Step 8 adds an asset-URL refresh endpoint.
- **A scheduled sweep every 15 minutes** aborts uploads past their 24 h deadline (storage stops billing for their parts),
  fails uploads stuck mid-completion, and deletes projects that never received a video. Deleting a project removes its rows
  immediately and its files through a job; a queued processing job is withdrawn, and one already running stops at its next stage.
- **Orphaned multipart uploads.** If the database refuses after storage opened an upload, the API aborts it before replying. For
  anything that still slips through (a crash), production buckets should also carry an S3 lifecycle rule
  `AbortIncompleteMultipartUpload` after 2 days; noted in the AWS mapping.

## Step 5: the processing pipeline

- **Eight stages, five steps.** The front end's Processing screen has five steps; the pipeline has eight stages that map
  onto them: `probe`, `scenes`, `split_proxy` (step 1, "Splitting into clips"), `audio`, `transcribe` (step 2),
  `index`, `timeline` (step 3), `ready` (step 4). Each owns a slice of the 0-100 bar. The job carries the exact step
  labels, `found` (scenes, language, speakers, hooks) and the failure shape the mock used, so the screen needs no change.
- **Silences are found with the scenes**, not in the index stage, because splitting a long unbroken shot needs to know
  where the pauses are. A talking head has no picture cuts at all, so without this a 10 minute podcast would be one clip.
  `MAX_SCENE_SEC` (default 60) splits at the middle of a nearby pause, else evenly.
- **Resumable by construction.** Every stage records its result in `job_stages` when it finishes and is idempotent (it
  replaces whatever an earlier try left, in one transaction). A retry, by the queue or by the user, skips finished
  stages and resumes at the one that failed; a worker crash costs at most one stage. `POST /jobs/:id/retry` (Step 6)
  uses `requeueProcessingJob`, which keeps the job id as the front end expects. Tested by checking that earlier stages are
  not started again (timestamps unchanged).
- **Failures are classified.** A `PermanentError` (no audio, damaged file, a provider that refuses) goes to the queue as
  unrecoverable and is never retried. Everything else is retried with exponential backoff (`JOB_ATTEMPTS`, default 5;
  `JOB_BACKOFF_MS`, default 2 s). A job out of attempts is marked `failed` and the queue keeps it (`removeOnFail: false`):
  that is the dead-letter path, inspectable in Redis and in the `jobs`/`job_stages` rows. The user sees plain words;
  the technical reason (and never an API key) stays in the log and the stage row.
- **The mock's failure, for real.** A video with no audio track fails at step 2 with "We couldn't read a clear audio
  track from this file." and detail "Transcribing stopped", the same words and shape as the mock.
- **Cancellation.** Deleting a project withdraws its queued job; a running one is stopped within about 3 seconds (a
  watcher aborts an `AbortSignal` that kills the FFmpeg or Whisper child process). Nothing is written back, and the
  project does not reappear.
- **Memory-safe and disk-light.** Downloads and uploads are streams (hashing on the way down). FFmpeg and Whisper are child
  processes. Each scene clip is uploaded and deleted straight away, so a job's disk use is about the original plus one clip.
  The work directory sits under `TMP_DIR` only and is removed however the job ends.
- **Stream copy where possible.** A scene clip is copied without re-encoding when its start is on a keyframe (within 40 ms),
  and re-encoded only otherwise. The proxy is at most 540p H.264 with a keyframe every second, plus the voice track. No HLS/DASH.
  Scene clips are stored but the editor plays only the proxy in Phase 1; they exist for rendering later.
- **Transcription behind an interface.** `whisper-local` (whisper.cpp, no account), `openai` and `assemblyai`, chosen by
  `TRANSCRIPTION_PROVIDER`; the app refuses to start without the chosen provider's key. Hindi and Hinglish both use the
  Hindi model, because none is made for Hinglish. Only AssemblyAI separates speakers; local Whisper and OpenAI give one.
  Hosted providers' errors are classified retryable (network, 429, 5xx) or not (bad key, 4xx), and a reply with neither word
  nor segment list is an error, not an empty transcript (so speech is never silently lost).
- **What was said is stored as heard.** Each word keeps both spellings: `text` (Roman) and `dev` (Devanagari), whichever
  the recogniser gave being the original and the other derived. Each word is marked `hi` or `en` (so a mixed sentence
  renders correctly), fillers are flagged, sentences found, and `dev` is only filled where we know the spelling.
- **Hinglish engine = lexicon + rules, deliberately best-effort.** `src/transcription/lexicon.ts` lists ~300 Hindi words and
  ~200 English loanwords in both scripts (so फंडिंग is "funding", not "phanding"); everything else goes through rule-based
  Devanagari to Roman (schwa deletion, conjuncts, nukta), which reads like Hinglish typing (`samajhna`, `larki`). **The reverse,
  Roman to Devanagari, is lexicon-only**: rule-based guesses ("kitab" could be किताब or कितब) were wrong often enough that a
  wrong spelling was worse than none, so unknown Roman words stay Roman in Devanagari mode. A language-model pass can fill
  those gaps in Phase 2. Words like "the" (थे) and "is" (इस) are Hindi in the lexicon and English in life; they take the
  language of their neighbours instead of voting.
- **Search form folds spelling variants.** Roman Hinglish has no fixed spelling and Whisper adds its own: real output for
  "funding" was `phunding`. `norm` (what is stored and what a query will be folded with, in Step 8) folds ph/f, long and
  short vowels, doubled letters and digraphs, w/v, z/j and c/k, and nothing more; pg_trgm covers what is spelled further apart.
- **Hooks and chapters are heuristics.** Question openers, numbers, strong-claim words, pace, fillers and a clean start score
  a window; non-overlapping best ones are kept, with a one-line reason. Chapters break at pauses after a minimum length.
  Scenes are named after the chapter they start in, as the editor's samples are. An LLM can replace the scoring later; the
  output fields do not change.
- **The first timeline** is the editor's own layout (video, B-roll, voice, captions, plus two advanced tracks), one video and one
  voice clip per scene, captions empty on purpose, as version 0 "Original upload". **B-roll starts empty**: the mock invented four
  placeholder clips with no footage behind them, and a clip that plays nothing is a lie.
- **Verified with real speech.** `whisper.cpp` v1.9.5 and the `small` model were run on speech synthesised with macOS voices
  (Hindi, Indian English, a Hinglish mix): word timings, Devanagari output and the whole pipeline work, on the laptop and in Docker.
  Those tests skip themselves where the binary, model or voices are missing. Synthetic speech is easier than real speech in
  some ways and harder in others; real creator audio should be tried before launch, and `medium` considered for Hindi.
- **Docker.** whisper.cpp is built from source in a build stage (`GGML_NATIVE=OFF`, portable across CPUs); the model is
  downloaded once into a volume by a `whisper-model` service (`WHISPER_MODEL=tiny|base|small|medium`). The first `docker compose
up` therefore downloads ~465 MB.

## Agreed with the product owner before building

- Auth tokens travel in httpOnly cookies (SameSite=Lax, Origin check). Bearer tokens are also accepted for
  non-browser clients.
- In real mode the front end keeps using MSW for `/style/*` only (Phase 3).
- The MP4 render stays a stand-in in Phase 1. OTIO export is real.
- The backend lives in its own folder and git repo (`lypcut-backend`), next to the front end.
