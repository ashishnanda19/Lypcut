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

## Step 6: live job status

- **WebSocket, because that is what the front end's mock mirrors.** `GET /api/jobs/ws` speaks the front end's protocol:
  the client sends `{type:'subscribe', jobId}`, the server sends `{type:'job', job}` (and `{type:'error', jobId, message:'Unknown
job'}` for anything it will not show). `GET /api/jobs/:id` is the polling fallback and returns the identical object. A last
  message from the feed and a poll made at the same moment are byte-for-byte equal (tested).
- **Every message is a full snapshot, never a delta.** That is what makes reconnecting trivial and correct: the client
  subscribes again and is told where things stand, nothing needs replaying, and late, duplicate or out-of-order messages cannot
  corrupt anything. It is also why there are no event ids. An unchanged state is never sent twice.
- **Authorised twice.** The handshake is authenticated with the login cookie (a browser WebSocket cannot send an
  `Authorization` header; a script can use Bearer) and its `Origin` is checked, because cookies make a socket open to
  cross-site pages otherwise. Then each subscription is checked against job ownership. A stranger's job and a job that does not exist
  get the same `Unknown job`, so ids cannot be probed. At most 20 jobs per connection.
- **Delivery path.** The worker writes the job row (the source of truth) and publishes `{jobId}` on a Redis channel. Each API
  instance holds one Redis subscriber; on a message it reads the row once (bursts of updates are coalesced into one read) and
  sends the result to whoever is watching that job. Instances share nothing else, so any number can run. A slow timer
  (`JOBS_WS_REFRESH_MS`, 3 s) re-reads watched, unfinished jobs, so a lost Redis message shows up within seconds (tested by
  changing a row without announcing it).
- **Hygiene.** Messages over 4 KB close the connection (1009). Malformed or unknown messages are ignored without a reply,
  as the mock ignores them (a reply of `type:'error'` would make the client fall back to polling). Dead connections are pinged out
  every 30 s. Slow clients are skipped rather than buffered for. On shutdown clients get a proper 1001 "going away".
- **Retry** (`POST /api/jobs/:id/retry`) resumes a failed processing job at the stage that failed and keeps its id. Pressing
  it twice is safe (a queued or running job just reports where it is); retrying a finished job is a 409.
- **The mock-only `fail` in a job id** is not a backend feature and is ignored. Real failures arrive through the same event shape
  as the mock failure: `status: 'failed'`, `step`, `found`, a readable `error`, and "<step> stopped" as `detail`.

## Step 7: the timeline API and reversible operations

- **The server is the source of truth for edits.** Every change, the user's now and the assistant's in Phase 2, is a list of
  `TimelineOp`s that goes through one engine (`src/timeline-core/ops.ts`), inside one database transaction that also checks the
  client was looking at the latest version. The engine has no HTTP, database or storage code and does not know who is asking, so
  the assistant can later call `TimelineService.applyOps` directly and its ops pass the same gate. HTTP lets a client label an
  edit `ai` (the front end's planner runs in the browser in Phase 1); that is a label, not a privilege.
- **A faithful port, proven by a differential test.** `ops.ts` and `queries.ts` are the front end's engine. `npm run parity` runs
  both on identical random edits (1,304 of them): 1,128 give identical results, 173 are refused by both with the same message.
  Three differences are deliberate and listed below.
- **Deliberate differences from the front end's engine.**
  1. _Deterministic ids._ New clips (a split's second half, a ripple's remainder) get ids from `i_v<version>_<n>`, not random
     ones, so an edit has one result. The client adopts the server's timeline rather than computing its own.
  2. _Canonical order._ The engine walks clips sorted by id. The first version walked them in key order, which Postgres `jsonb`
     does not preserve, so the "deterministic" ids changed with how a timeline had been stored. A model-based test caught it
     (the server and a mirror model disagreed at step 40 of a random run); a test now shuffles key order and requires identical results.
  3. _Value comparison._ "Did this clip change" and `inverseConflicts` compare by value, not object identity (a timeline from the
     database shares no objects with another).
- **A bug in the front end, found by the server's own checks.** Trimming the start of a clip _shorter than 0.1 s_ makes the front
  end's `clamp(to, lo, itemEnd - 0.1)` bounds cross, which moves the clip to a negative time and negative source time. The server's
  invariants refuse to store that, and the backend's `doTrim` treats such a clip as unable to shrink. **The front end needs the same
  one-line fix (done in Step 9);** `npm run parity` reports these cases as "known" until then and fails on them with `STRICT=1`.
- **Invariants after every op.** A leaf op enforces its own rules (overlap, locked tracks, ranges). On top of that every result must
  have: clips on existing, compatible tracks; finite times; no negative start or source time (beyond 1 ms of engine rounding dust);
  positive length; keys equal to ids; at most 20,000 clips. This is the backstop for the low-level `patch` op, which can say anything.
  It checks structure, never taste.
- **Strict input.** Ops are validated by a Zod schema before the engine sees them: every field typed and bounded, **unknown keys
  refused** (nothing can be smuggled into a stored timeline), at most 200 ops per request, batches nested at most 4 deep, 2,000 ops in
  all. Nesting depth is measured with an explicit stack _first_, because validating a payload nested thousands of levels deep would
  overflow the validator's own stack (found by a test): that is now a 422, not a 500. Structural problems are `VALIDATION_ERROR`; an
  op the engine refuses is `INVALID_OP` with its message and `{ opIndex, opType }`.
- **Versions, a cursor and a redo stack.** Each edit writes a full snapshot plus the op and its inverse as version `n` with a parent.
  `currentVersion` is the cursor: undo moves it to the parent, redo to the version it came from, and neither deletes anything. A
  new edit after an undo starts a branch (the abandoned versions stay, visible in History and restorable) and clears the redo stack.
  This is exactly the front end's model (`versions[cursor]`, forward versions archived).
- **Optimistic concurrency.** Every write sends the `baseVersion` it was looking at; the timeline row is locked `FOR UPDATE`, and a
  mismatch is a 409 `VERSION_CONFLICT` with `{ currentVersion, lastVersion }`. Two requests on one version: exactly one wins.
  Edits to different projects never wait on each other. A refused op leaves nothing behind (version, op log, snapshot) even if
  earlier ops in the request were fine.
- **One version per request.** A request is a batch and makes one version, so undo undoes the request. Its stored `inverse` is the
  single patch `patchBetween(after, before)`; `timeline_ops` also logs each op with its own inverse for audit.
- **Restore is non-destructive**: it adds a new version whose change is "become that one", so nothing in the history is lost and the
  restore itself can be undone. Restoring what already is the current state is a 409, as in the front end.
- **History without weight.** `GET .../history` lists versions (newest first, paged by `before`) with `current`, `onBranch` and
  `redoable` flags and no snapshots; `GET .../versions/:n` returns one in full. Snapshots are stored whole (simple, and a restore needs
  them); at roughly 100 KB for a 300-clip timeline a retention policy (keep every Nth, prune old branches) will be wanted before very long
  editing sessions are common. A single snapshot is capped at 8 MB.
- **OTIO export** (`GET /projects/:id/export/otio`) writes what the front end writes, and also keeps everything Lypcut needs to
  read its own file back exactly (exact times, ids, empty tracks, full settings) under `metadata.lypcut`, which other tools ignore.
  `fromOtio` reads it back: the round-trip tests compare the rebuilt timeline to the original across hand-built and random edit
  histories. A plain OTIO file from another tool is refused with a clear message rather than guessed at. Clips point at the original
  upload's file name (`media/<name>`) so an editor relinks the obvious file. The download name is safe for Hindi titles
  (ASCII fallback plus RFC 5987 `filename*`).

## Step 8: read APIs

- **Content is read by what the editor already calls.** `GET /projects/:id/transcript | scenes | highlights | chapters | search` return the
  front end's types exactly (a word's `filler` only when true, sentence ids `s0..`, highlight ids `hl_0..`, best hook first). Scene ids
  (`s0`) match the timeline's clip ids (`v_s0`, `a_s0`), so a scene and its clips line up.
- **The transcript is whole by default, with an optional time range.** The editor loads it once and works from it (and sentence and
  search indices point into the full word list), so the default is everything. `?from=&to=` (seconds) returns only the words overlapping that
  range, with sentence indices left global and `range.wordOffset` saying where the slice starts: that is the paging a very long
  recording needs. Fixed-size paging by word count would break those global indices.
- **"Not ready" is an error, not an empty list.** Reading content of a project still processing is `409 NOT_READY`. The editor caches
  these responses forever, so an empty answer given too early would stay empty.
- **Files are links, never bytes.** `GET /projects/:id/assets[?kind=]` lists a project's files, each with a link that expires (default
  1 h, `PRESIGN_GET_TTL_SEC`) and is signed for that one object; `GET .../assets/:id/url` mints a fresh one, because a long editing
  session outlives the links in the project payload. Byte ranges work (streaming 206), the original and exports download under the name the person
  gave them, a file that is not ready has no link, and with `CDN_BASE_URL` set the links point at the CDN instead (CloudFront signing slots
  into `Storage.presignGet`). Nothing is proxied through the API.
- **Search keeps the editor's behaviour, and finds more.** The scoring is the front end's (`src/lib/search.ts`): filler words dropped from
  a natural query, weighted matches (exact, prefix, synonym group, one typo), sentences kept above a threshold, short ones widened with
  the next for context, no overlapping clips. Two improvements: words are compared by their **spelling-folded key**, so "funding" finds
  "phunding" (a real Whisper spelling), and Devanagari and Roman queries meet through the lexicon.
- **Postgres narrows, code decides.** The database does the indexed part: a full-text prefix query over the Roman form (`tsvector`), trigram
  similarity (`pg_trgm`, `<%`, threshold set per transaction) for near spellings, and a substring match for Devanagari. Only those
  sentences (capped at 600) have their words loaded and scored in code. Scoring in code keeps the ranking independent of the database's
  locale, which changes how Devanagari is split into words between a laptop and RDS. A **differential test** compares the service with the
  in-memory algorithm over 60 queries (Roman, Devanagari, synonyms, typos, whole sentences) and requires identical results; mutating away the
  trigram condition fails it.
- **Hostile queries are plain text.** Folded Roman forms are `a-z0-9` only, so a text-search query cannot be malformed by what someone types;
  LIKE wildcards are escaped; everything else is a bound parameter. Tested with SQL fragments, wildcards, NULs, emoji, other scripts and a
  200-character query. Over 200 characters is a 422; under 2 is no search.
- **Performance.** An 80,000-word transcript (about 7,000 sentences) is searched in well under 1.5 s (a test bar, not the typical figure).
- **A summary endpoint** (`GET /projects/:id/summary`) returns counts of what was found and the timeline version in one call.
- **Responses are compressed** (brotli or gzip above 1 KB): transcripts and timelines are large JSON that compresses well.

## Step 9: the front end uses the real API

The front end (`../lypcut`) is switched by `VITE_API_MODE=real|mock` (mock is the default, so the demo still works with no
server). In real mode the in-browser mock answers only `/api/style/*`. Everything below is a change on the front-end side
unless it says otherwise; the backend changed in two small ways, noted at the end.

- **The dev server proxies `/api` (and the job socket) to the backend**, so the browser sees one origin and the login
  cookies are first-party. Nothing about the backend needed CORS for this; the Origin check still applies (the page's origin
  must be in `CORS_ORIGINS`).
- **Errors.** The mock sent `{ message, field }`; the backend sends `{ error: { code, message, details } }`. The client reads
  both, so the forms show the server's message beside the field it names, and the plan-limit codes reach the upload screen.
- **Sessions.** The client holds no token. An expired access token (15 minutes) triggers one refresh however many calls fail
  together (the refresh token is single use), then the call is repeated; a refused refresh signs the person out with a
  message. On load, a stored sign-in is checked with `GET /me`; only a 401 clears it, so a server outage does not log anyone out.
- **Signup needs 8 characters** (was 6), in the form, the mock and the copy.
- **Upload flow inverted**, as noted in Step 4: create the project, open an upload, send parts, complete. The new `Uploader`
  sends three parts at once with `XMLHttpRequest` (for progress), retries a part with backoff, asks for fresh links when
  storage refuses an expired one, and after a pause or a dropped connection continues from what storage holds. Leaving the
  page pauses it; "Choose the file again" on the project then finishes the _same_ upload in the _same_ project. A file the
  plan refuses is reported once, with no Retry, and the empty project it would leave is deleted.
- **Edits are saved as they are made.** The editor still applies every change at once, then a queue sends it with the
  version it was based on and adopts the server's answer. A failed save (refused op, a conflict from another tab, an outage)
  reloads the saved version and says so; the top bar shows Saving, Saved or Not saved, and closing the tab mid-save warns.
- **Both sides give new clips the same ids.** The server numbers clips an edit creates `i_v<version>_<n>`; the front end's
  engine now takes the same generator, and walks clips in id order as the server does. The editor knows the next version
  number (every edit is one, undo and redo are not), so a second edit can name a clip the first created before the server has
  answered. `npm run parity` now gives both engines the same generator and compares ids too: 1,304 random edits, identical.
- **The front end's trim bug is fixed** (a start-trim on a clip shorter than 0.1 s pushed it before the start of the
  timeline); `STRICT=1 npm run parity` reports no known divergences.
- **History after a reload.** The editor loads the saved versions around where the timeline is (12 behind, 12 ahead), so
  Undo and Redo work at once and survive a reload. Older edits, and edits on other branches, are listed as "Earlier saved
  edits": they can be viewed and restored from the server (restore is the real `restore` endpoint, which adds a new version).
  Within a session, branches behave exactly as before.
- **The video link is refreshed** shortly before it expires (read from the link's own `X-Amz-Expires`), and never while the
  video is playing, so a long editing session does not end in a black player.
- **Export.** The project file (.otio) is downloaded from the server after pending saves land. The MP4 render stays a
  stand-in, as agreed: against the real backend its progress is simulated in the browser and the download is the editing
  copy of the original, which the toast says plainly.
- **Hidden in real mode:** "Add sample projects" and the Google button (the backend answers 501 for Google; a button that always
  fails looks unfinished).
- **Logging out** now lands on the landing page. Before, the route guard noticed the missing user first and sent the person
  to the login form. Found by the new Playwright test.
- **Not persisted, on purpose:** the chat transcript and the Edit cards. The assistant is still the browser's planner (Phase 2);
  edits it applies are saved like any other, labelled `ai`.
- **Two backend changes came out of this step.** (1) Routes with an optional body (`/auth/refresh`, `/auth/logout`,
  `/uploads/:id/complete`) rejected a request with _no_ body at all, because Fastify hands validation `null`; a browser
  refreshing with only its cookie hit it. The test client had always sent `{}`, which hid it; it now sends what a real client
  sends. (2) OpenAPI now has a tag and a summary on every route, enforced by a test, and `API.md` is checked against the code.
  Also: production refuses the example `AUTH_ACCESS_SECRET` from `.env.example`.

## Agreed with the product owner before building

- Auth tokens travel in httpOnly cookies (SameSite=Lax, Origin check). Bearer tokens are also accepted for
  non-browser clients.
- In real mode the front end keeps using MSW for `/style/*` only (Phase 3).
- The MP4 render stays a stand-in in Phase 1. OTIO export is real.
- The backend lives in its own folder and git repo (`lypcut-backend`), next to the front end.
