# Lypcut API

Everything is under `/api`, except the two health probes. The same reference, generated from the code, is served at
`/docs` (Swagger UI) and `/docs/json` (OpenAPI) when `NODE_ENV` is not `production`. A test keeps this file and the
code in step: every endpoint below exists, and every endpoint that exists is below.

Examples use `$A` for `http://localhost:4000/api` and shorten ids and tokens. The responses are real.

- [Conventions](#conventions)
- [Health](#health) · [Auth](#auth) · [Account](#account) · [Projects](#projects) · [Uploads](#uploads)
- [Jobs](#jobs) · [Timeline](#timeline) · [Content](#content) · [Search](#search) · [Assistant](#assistant) · [Style](#style)
- [Errors](#error-codes)

## Conventions

**Sign-in.** A browser gets two httpOnly cookies from `signup` or `login`: `lypcut_at` (access, 15 minutes) and
`lypcut_rt` (refresh, 30 days, sent only to `/api/auth`). Any other client sends `X-Auth-Mode: bearer` on `signup`/`login`
and gets the tokens in the body; send the access token as `Authorization: Bearer <token>`. A browser's writes must
come from an origin listed in `CORS_ORIGINS`.

**Errors** are always `{ "error": { "code", "message", "details"? } }` with an HTTP status. `message` is written for
people and safe to show. `code` is for programs (see [Error codes](#error-codes)).

**Ownership.** Every project, upload, file and job belongs to one person. Asking for someone else's returns `404`,
the same as for something that does not exist.

**Ids** are UUIDs (v7, so they sort by creation time). **Times** in content are seconds in the original video (source
time); timeline clips carry both `start` (timeline time) and `srcIn` (source time).

**Rate limits.** Sign-in endpoints allow 10 requests a minute per IP, and 5 wrong passwords lock an account's logins for
15 minutes. Other endpoints allow 300 a minute per IP. `429` carries `Retry-After`.

**Compression.** Responses over 1 KB are compressed when the client sends `Accept-Encoding`.

```bash
A=http://localhost:4000/api
# Get a token to use in the examples below.
T=$(curl -s -X POST $A/auth/login -H 'content-type: application/json' -H 'X-Auth-Mode: bearer' \
     -d '{"email":"asha@example.com","password":"correct-horse-battery"}' | jq -r .tokens.accessToken)
H="authorization: Bearer $T"
```

## Health

### GET /health

Is the process up. No dependencies are checked. Answers `{ "status": "ok" }`. (Not under `/api`.)

### GET /ready

Are Postgres, Redis and storage reachable. `200` when all are; `503` with `"status": "not_ready"` and the failing check
(or `"status": "draining"` while the server shuts down). (Not under `/api`.)

```json
{ "status": "ready", "checks": { "postgres": "ok", "redis": "ok", "storage": "ok" } }
```

## Auth

### POST /auth/signup

Create an account and sign in. Name 1-80 characters, a valid email, a password of **8-128** characters.

```bash
curl -X POST $A/auth/signup -H 'content-type: application/json' -H 'X-Auth-Mode: bearer' \
  -d '{"name":"Asha Verma","email":"asha@example.com","password":"correct-horse-battery"}'
```

`201`:

```json
{
  "user": {
    "id": "01a16cf4-3da6-789f-…",
    "name": "Asha Verma",
    "email": "asha@example.com",
    "language": "hinglish",
    "contentType": null,
    "onboarded": false,
    "plan": "free"
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9…",
    "refreshToken": "OvjxsGN3qav…",
    "expiresIn": 900
  }
}
```

Without `X-Auth-Mode: bearer` the `tokens` are omitted and the cookies are set instead. An email already in use is
`409 EMAIL_TAKEN`. A bad field is `422 VALIDATION_ERROR` with `details.field`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Enter a valid email, like aarav@gmail.com.",
    "details": {
      "field": "email",
      "issues": [
        { "path": "email", "message": "Enter a valid email, like aarav@gmail.com." },
        { "path": "password", "message": "Choose a password with at least 8 characters." }
      ]
    }
  }
}
```

### POST /auth/login

Body `{ "email", "password" }`. Same response as signup. A wrong email and a wrong password are indistinguishable:

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "That email or password is not right." } }
```

### POST /auth/refresh

Trade the refresh token (the cookie, or `{ "refreshToken" }` in the body) for a new session. **Each refresh token works
once**; the response carries the next. Using an old one again ends the whole login (it may have been stolen), except
within 10 seconds of its use, which is treated as two tabs racing. A client should therefore refresh one at a time.
An empty body is fine.

### POST /auth/logout

Ends this session on the server and clears the cookies. Always answers `{ "ok": true }`.

### POST /auth/google

Not available yet: `501 NOT_IMPLEMENTED`.

## Account

### GET /me

```bash
curl $A/me -H "$H"
```

```json
{
  "user": {
    "id": "01a16cf4-3da6-789f-…",
    "name": "Asha Verma",
    "email": "docs8740@example.com",
    "language": "hinglish",
    "contentType": null,
    "onboarded": false,
    "plan": "free"
  }
}
```

### PATCH /me

Any of `name`, `language` (`hi`, `hinglish`, `en`), `contentType` (`youtuber`, `business`, `clipper`, or `null`), and
`onboarded: true` (it cannot be switched back off). Returns `{ "user" }`.

### DELETE /me

Deletes the account and every project, upload, file and session that belongs to it. Returns `{ "ok": true }`.

## Projects

A project is one video and everything made from it. `status` is `uploading` (waiting for the file), `processing`,
`ready`, `exported` or `failed`.

### GET /projects

The person's projects, newest first, as a bare array of the objects below.

### POST /projects

Creates an empty project to upload into. `fileName` is required; `title` defaults to the file name without its
extension; `durationSec` is what the browser read from the file and is used only to refuse an over-long video early.

```bash
curl -X POST $A/projects -H "$H" -H 'content-type: application/json' \
  -d '{"fileName":"funding-kaise-raise-karein.mp4","durationSec":8}'
```

`201`:

```json
{
  "project": {
    "id": "01a16cf4-3e0c-75c9-…",
    "title": "funding-kaise-raise-karein",
    "status": "uploading",
    "durationSec": 0,
    "language": "hinglish",
    "thumbSeed": "01a16cf4-3e0c-75c9-…",
    "createdAt": "2026-10-24T08:08:28.429Z",
    "updatedAt": "2026-10-24T08:08:28.431Z",
    "assets": []
  }
}
```

### GET /projects/{id}

One project (not wrapped). While it processes it has `progress` (0-100) and `jobId`; once ready it has `hooksFound`
and its files. `assets` lists the original (`raw`) and the editing copy (`proxy`); only the proxy has a `url`, a link
that works for an hour (`PRESIGN_GET_TTL_SEC`).

```json
{
  "id": "01a16cf4-3e0c-75c9-…",
  "title": "funding-kaise-raise-karein",
  "status": "ready",
  "durationSec": 7.804438,
  "language": "hi",
  "thumbSeed": "01a16cf4-3e0c-75c9-…",
  "createdAt": "2026-10-24T08:08:28.429Z",
  "updatedAt": "2026-10-24T08:08:36.522Z",
  "jobId": "01a16cf4-3f73-7158-…",
  "hooksFound": 0,
  "assets": [
    {
      "id": "01a16cf4-3e57-…",
      "kind": "raw",
      "label": "funding-kaise-raise-karein.mp4",
      "durationSec": 7.804438
    },
    {
      "id": "01a16cf4-42bb-…",
      "kind": "proxy",
      "label": "Editing proxy (360p)",
      "durationSec": 7.808,
      "url": "http://localhost:9000/lypcut/users/…/proxy/proxy.mp4?X-Amz-Expires=3600&X-Amz-Signature=…"
    }
  ]
}
```

### PATCH /projects/{id}

Body `{ "title" }` (1-120 characters). Returns the project.

### DELETE /projects/{id}

Deletes the project and its files. Returns `{ "ok": true }`.

## Uploads

The video never passes through the API. The client asks for short-lived links and sends each part straight to storage;
the API coordinates and checks the result. Uploads are resumable: storage, not the client, is the record of which parts
arrived.

1. `POST /projects`, then `POST /uploads` with the returned project id.
2. `POST /uploads/{id}/parts` for the part numbers to send; `PUT` each part's bytes to its `url` (no other headers).
3. `POST /uploads/{id}/complete`. The server checks every part, the size, an optional checksum, and the file itself
   (by content, not by name), then starts processing.

If the connection drops, `GET /uploads/{id}` says which parts storage holds; send only the rest. Starting the same file
again (same project, name and size) resumes the open upload and answers `200` instead of `201`. An upload that is not
completed within 24 hours expires and its parts are freed.

### POST /uploads

```bash
curl -X POST $A/uploads -H "$H" -H 'content-type: application/json' \
  -d '{"projectId":"01a16cf4-3e0c-…","fileName":"funding-kaise-raise-karein.mp4","contentType":"video/mp4","sizeBytes":833201,"durationSec":8}'
```

`201`:

```json
{
  "upload": {
    "id": "01a16cf4-3e60-74a2-…",
    "projectId": "01a16cf4-3e0c-75c9-…",
    "status": "initiated",
    "fileName": "funding-kaise-raise-karein.mp4",
    "sizeBytes": 833201,
    "partSize": 16777216,
    "totalParts": 1,
    "parts": [],
    "bytesReceived": 0,
    "expiresAt": "2026-10-25T08:08:28.485Z"
  }
}
```

A Reel that teaches the assistant your style uses the same upload with no project: send `"purpose": "style_reel"` instead of
`projectId` (exactly one of the two). `upload.projectId` is then `null`. See [Style](#style).

Every part except the last is exactly `partSize` bytes. Plan limits are checked here: `403 LIMIT_VIDEO_LENGTH`
(`details.maxSeconds`, `details.durationSec`) and `403 LIMIT_MONTHLY_UPLOADS` (`details.max`). Free is 10 minutes
and 3 uploads a month.

### GET /uploads/{id}

The upload as above, with `parts` listing what storage holds, for example
`"parts": [{ "partNumber": 1, "size": 833201 }]`.

### POST /uploads/{id}/parts

Body `{ "partNumbers": [1, 2, 3] }` (1-100 numbers, each within `totalParts`). Each link is signed for one object, one
part and one verb.

```json
{
  "urls": [
    {
      "partNumber": 1,
      "url": "http://localhost:9000/lypcut/users/…/raw/….mp4?partNumber=1&uploadId=…&X-Amz-Signature=…"
    }
  ],
  "expiresIn": 3600
}
```

```bash
curl -X PUT --data-binary @part1.bin "$URL"
```

### POST /uploads/{id}/complete

Optional body `{ "checksum": "<sha-256 hex of the whole file>" }`, verified if sent. Returns the upload, the project
(now `processing`, with a `jobId`) and the job. Calling it again returns the same result without a second job.

```json
{
  "upload": { "status": "completed", "…": "…" },
  "project": { "status": "processing", "progress": 0, "jobId": "01a16cf4-3f73-…", "…": "…" },
  "job": { "id": "01a16cf4-3f73-…", "kind": "processing", "status": "queued", "progress": 0 }
}
```

Refusals: `422 UPLOAD_INCOMPLETE` (`details.missing`, `details.wrongSize`: send those parts again and retry),
`422 CHECKSUM_MISMATCH`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA` (not a video), `403 LIMIT_*`, and
`410 UPLOAD_EXPIRED` (start a new upload for the same project). A refusal about the file itself discards the file but
leaves the project waiting for another.

### DELETE /uploads/{id}

Abandons the upload and frees its parts. Returns `{ "ok": true }`.

## Jobs

Processing runs in a worker and is reported as a job: `queued`, `running`, `done` or `failed`, with `step` 0-4
(uploaded, splitting, transcribing, indexing, ready) and a one-line `detail`.

```json
{
  "id": "01a16cf4-3f73-7158-…",
  "projectId": "01a16cf4-3e0c-…",
  "kind": "processing",
  "status": "running",
  "progress": 0,
  "step": 1,
  "detail": "Splitting into clips"
}
```

```json
{
  "id": "01a16cf4-3f73-7158-…",
  "projectId": "01a16cf4-3e0c-…",
  "kind": "processing",
  "status": "done",
  "progress": 100,
  "step": 4,
  "detail": "Ready to edit",
  "found": { "language": "Hindi", "speakers": 1, "scenes": 1, "hooks": 0 }
}
```

A failed job has `status: "failed"`, `error` (readable) and `detail` ("Transcribing stopped").

### GET /jobs/{id}

The job's current state. This is the polling fallback of the live feed and returns the identical object.

### POST /jobs/{id}/retry

Resumes a failed processing job at the stage that failed, keeping its id. Pressing it twice is safe. Retrying a job
that finished is `409 CONFLICT`.

### WebSocket /api/jobs/ws

The live feed (not in OpenAPI). Connect with the login cookie from an allowed origin (a script can use `Authorization:
Bearer`). Send `{"type":"subscribe","jobId":"…"}`; receive `{"type":"job","job":{…}}` whenever it changes. Every message
is a complete snapshot, so after a reconnect just subscribe again. A job that is not yours, or does not exist, answers
`{"type":"error","jobId":"…","message":"Unknown job"}`. Up to 20 jobs per connection; messages over 4 KB close it.

## Timeline

The server is the source of truth for edits. Every change is a list of **ops** applied together as one new **version**,
with undo and redo over the versions. Clients send the `baseVersion` they were looking at; if it is not the current
one the edit is refused with `409 VERSION_CONFLICT` and the client reloads.

A timeline is `{ tracks, items, settings, sourceDuration }`. `items` is an object of clips by id, each
`{ id, trackId, kind, label, start, duration, srcIn, meta? }` (`kind`: video, broll, audio, caption, effect).
Ids of clips an edit creates are `i_v<version>_<n>`, so the same edit always gives the same ids and a client can
predict them.

### GET /projects/{id}/timeline

```json
{
  "version": 0,
  "lastVersion": 0,
  "canUndo": false,
  "canRedo": false,
  "timeline": {
    "items": {
      "v_s0": {
        "id": "v_s0",
        "kind": "video",
        "label": "Intro",
        "trackId": "trk_video",
        "start": 0,
        "duration": 7.804438,
        "srcIn": 0
      },
      "a_s0": { "…": "…" }
    },
    "tracks": [{ "id": "trk_video", "kind": "video", "name": "Video" }, "…"],
    "settings": { "crop": { "x": 0.5, "y": 0.5, "scale": 1 }, "…": "…" },
    "sourceDuration": 7.804438
  }
}
```

`version` is where the timeline is now (send it back as `baseVersion`); `lastVersion` is the highest number issued,
which is higher after an undo. `409 NOT_READY` until processing has built the timeline.

### POST /projects/{id}/timeline/ops

```bash
curl -X POST $A/projects/$PID/timeline/ops -H "$H" -H 'content-type: application/json' \
  -d '{"baseVersion":0,"label":"Split the clip","ops":[{"type":"split","itemId":"v_s0","at":3}]}'
```

`ops` holds 1-200 ops of these types: `trim`, `split`, `move`, `delete`, `rippleDelete`, `cutSource`, `restoreSource`,
`addCaptions`, `addEffect`, `setCrop`, `setCaptionStyle`, `setSettings`, `addMarker`, `removeMarker`, `patch`, and
`batch` (ops inside ops). Unknown fields are refused. `label` (1-200) is what History shows; `author` is `you`
(default) or `ai`; `editId` links the version to an Edit card in the chat. All the ops apply or none do.

```json
{
  "version": {
    "id": "v_1",
    "n": 1,
    "parentN": 0,
    "author": "you",
    "label": "Split the clip",
    "at": 1792829317393,
    "current": true,
    "onBranch": true,
    "redoable": false
  },
  "state": {
    "version": 1,
    "lastVersion": 1,
    "canUndo": true,
    "canRedo": false,
    "timeline": {
      "items": {
        "v_s0": { "duration": 3, "…": "…" },
        "i_v1_1": {
          "id": "i_v1_1",
          "kind": "video",
          "start": 3,
          "duration": 4.804438,
          "srcIn": 3,
          "…": "…"
        },
        "…": "…"
      },
      "…": "…"
    }
  }
}
```

Refusals:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This project changed since you last loaded it. Reload to see the latest.",
    "details": { "currentVersion": 1, "lastVersion": 1, "baseVersion": 0 }
  }
}
```

```json
{
  "error": {
    "code": "INVALID_OP",
    "message": "Clip nope was not found.",
    "details": { "opIndex": 0, "opType": "split" }
  }
}
```

Invalid structure is `422 VALIDATION_ERROR`. An edit after an undo starts a branch; the abandoned versions stay in
History and can be restored.

### POST /projects/{id}/timeline/undo

Body `{ "baseVersion" }`. Moves to the previous version and returns the state (as `GET .../timeline`). Nothing is deleted.
With nothing to undo it is `409 CONFLICT`.

### POST /projects/{id}/timeline/redo

Body `{ "baseVersion" }`. Moves forward to the version an undo came from. Nothing to redo is `409 CONFLICT`.

### GET /projects/{id}/timeline/history

Query `limit` (1-500, default 100) and `before` (a version number, to page back). Newest first, without snapshots.

```json
{
  "current": 1,
  "versions": [
    {
      "id": "v_1",
      "n": 1,
      "parentN": 0,
      "author": "you",
      "label": "Split the clip",
      "at": 1792829317393,
      "current": true,
      "onBranch": true,
      "redoable": false
    },
    {
      "id": "v_0",
      "n": 0,
      "parentN": null,
      "author": "you",
      "label": "Original upload",
      "at": 1792829316000,
      "current": false,
      "onBranch": true,
      "redoable": false
    }
  ],
  "hasMore": false
}
```

`onBranch` marks the versions that led to the current one; `redoable` the ones redo can reach.

### GET /projects/{id}/timeline/versions/{n}

One version in full: `{ version, op, inverse, timeline }`, where `inverse` is the op that undoes it.

### POST /projects/{id}/timeline/restore

Body `{ "baseVersion", "versionN" }`. Becomes an earlier version **as a new version**, so nothing is lost and the restore
can itself be undone. Returns `{ version, state }` like `ops`. Restoring what is already current is `409 CONFLICT`.

### GET /projects/{id}/export/otio

The current timeline as an OpenTimelineIO file (`content-disposition: attachment`), openable in DaVinci Resolve, Premiere
and others. It also carries everything Lypcut needs to read its own file back exactly, under `metadata.lypcut`.

## Content

These return `409 NOT_READY` while the project is still processing (an empty answer given too early would be cached).

### GET /projects/{id}/transcript

Optional `from` and `to` (seconds) return only the words overlapping that range, with `range.wordOffset` saying where
the slice starts in the whole transcript; sentence indices stay global. The default is everything.

```json
{
  "language": "hi",
  "speakers": [{ "id": "S1", "name": "Speaker 1", "color": "saffron" }],
  "words": [
    {
      "text": "aajka",
      "dev": "आजका",
      "start": 0.01,
      "end": 0.49,
      "speaker": "S1",
      "language": "hi"
    },
    {
      "text": "um",
      "dev": "उम",
      "start": 4.1,
      "end": 4.3,
      "speaker": "S1",
      "language": "en",
      "filler": true
    }
  ],
  "sentences": [{ "id": "s0", "speaker": "S1", "from": 0, "to": 22, "start": 0.01, "end": 7.6 }]
}
```

`text` is the Roman (Hinglish) spelling, `dev` the Devanagari one; `filler` appears only when true. A sentence's `from`
(inclusive) and `to` (exclusive) index the words. With `?from=1&to=3` the answer also has
`"range": { "from": 1, "to": 3, "wordOffset": 1 }`.

### GET /projects/{id}/scenes

`[{ "id": "s0", "label": "Intro", "start": 0, "end": 7.80, "thumbUrl": "http://…?X-Amz-Expires=3600&…" }]`. Scene ids match
the timeline's clip ids (`s0` is `v_s0` and `a_s0`).

### GET /projects/{id}/highlights

`[{ "id": "hl_0", "title": "…", "start": 12.4, "end": 41.0, "hookScore": 87, "reason": "…", "thumbSeed": "…" }]`, best hook first.

### GET /projects/{id}/chapters

`[{ "id": "ch_0", "title": "…", "start": 0, "end": 120.5 }]`.

### GET /projects/{id}/summary

Counts in one call, and where the timeline is.

```json
{
  "projectId": "01a16cf4-3e0c-…",
  "status": "ready",
  "durationSec": 7.804438,
  "language": "hi",
  "counts": {
    "words": 22,
    "sentences": 1,
    "scenes": 1,
    "highlights": 0,
    "chapters": 1,
    "silences": 0,
    "fillers": 0
  },
  "speakers": [{ "id": "S1", "name": "Speaker 1", "color": "saffron" }],
  "timeline": { "version": 0, "lastVersion": 0 },
  "assets": { "raw": 1, "scene_clip": 1, "proxy": 1, "thumbnail": 1, "audio": 1 }
}
```

### GET /projects/{id}/assets

Optional `kind` (`raw`, `proxy`, `thumbnail`, `scene_clip`, `audio`, `export`). Lists the project's files with their
`status`; a file that is ready has a `url` that works for `expiresIn` seconds (byte ranges work, so video streams and
seeks). The original and exports download under the name the person gave them. Nothing is proxied through the API;
with `CDN_BASE_URL` set the links point at the CDN.

```json
{
  "assets": [
    {
      "id": "01a16cf4-3e57-…",
      "kind": "raw",
      "label": "funding-kaise-raise-karein.mp4",
      "status": "ready",
      "mimeType": "video/mp4",
      "sizeBytes": 833201,
      "durationSec": 7.804438,
      "width": 640,
      "height": 360,
      "sceneId": null,
      "url": "http://localhost:9000/lypcut/users/…?X-Amz-Expires=3600&X-Amz-Signature=…"
    }
  ],
  "expiresIn": 3600
}
```

### GET /projects/{id}/assets/{assetId}/url

A fresh link for one file, because an editing session can outlast the links in the project payload.

```json
{
  "url": "http://localhost:9000/lypcut/users/…/proxy/proxy.mp4?X-Amz-Expires=3600&X-Amz-Signature=…",
  "expiresIn": 3600
}
```

## Search

### GET /projects/{id}/search

Finds moments by what was said. `q` is a word, a phrase or a natural request ("where I talk about the pitch"); under 2
characters finds nothing and over 200 is `422`. Roman and Devanagari spellings find each other, spelling variants
("phunding") and one-letter typos match, and related words match too (paisa finds funding). `limit` is 1-20, default 8.

```bash
curl -G $A/projects/$PID/search --data-urlencode "q=where I talk about the pitch" -H "$H"
```

```json
[
  {
    "id": "sr_0",
    "start": 0,
    "end": 8,
    "relevance": 93,
    "matched": [10],
    "from": 0,
    "to": 22,
    "thumbSeed": "search-0"
  }
]
```

Best first, never overlapping. `relevance` is 40-99, `matched` are word indices, and `from`/`to` are the word range of the
clip. A query with nothing to look for ("where I talk about the") answers `[]`.

## Assistant

The assistant turns a message (English, Hindi or Hinglish) into an **Edit card**: a plan the editor can preview and apply.
The model never writes timestamps or raw ops. It picks from a small set of tools by id (sentences `s3`, highlights
`hl_0`, chapters `ch_1`), the server builds the op, checks it against the same rules as `POST /timeline/ops`, and only
then saves it. A plan that does not pass is never returned. Nothing here touches the video: it is edits to the timeline.

The assistant also edits in the creator's own style (see [Style](#style)). When a person has a profile, "match my style" (or "meri style
lagao", or "मेरी स्टाइल लगाओ") builds one plan of ordinary ops: a Reel from the highlight that opens the way their best Reels do, pauses
and fillers tightened to how often they cut, and captions in their most-used look. With no profile it answers with how to get one and
`"route": "/app/style"`. With the **apply my style** switch on (`applyStyle: true`), captions and Reels default to their look and the plan's
description says so ("Using your saffron-pop style."); asking for captions or a Reel "in my style" applies it without the switch. When the
profile comes from few Reels (`confidence: "low"`) the reply says so and links to the Style page. Their style is never applied to anything
but what the plan's ops say, and the model sees only their usual look ids, cut pace, timing and one sentence: never the handle or any number
from Instagram.

Music is not offered. Asking for it is answered with a short explanation and no plan.

Each result is a `PlannerResult`: `text` always, and at most one of `plan`, `question`, `action` (`undo` or `redo`, for the
editor to carry out). `chips` are follow-up suggestions and `open` names a tab to show (`{ "tab": "search", "query": … }`).

### POST /projects/{id}/assistant/messages

```bash
curl -X POST $A/projects/$PID/assistant/messages -H "$H" -H 'content-type: application/json' \
  -d '{"text":"filler words hatao","playhead":0,"history":[]}'
```

`text` is at most 1,000 characters (control characters are stripped). `playhead` is timeline seconds. `history` is the last
few turns, up to 8, oldest first. `applyStyle` is accepted and ignored until style learning arrives.

```json
{
  "text": "3 filler words mile, jaise “um”, “basically,”, “matlab”. Ye raha cleanup. Chaho to pehle preview dekh lo.",
  "plan": {
    "id": "01a16ef1-c3ef-7fbc-a676-db6cf5e500f5",
    "title": "3 filler words hatao",
    "description": "“um”, “basically,”, “matlab” aur unke aaspaas ke pauses cut honge.",
    "op": { "type": "batch", "ops": ["…"] },
    "strip": [{ "kind": "keep", "weight": 16.4 }, { "kind": "cut", "weight": 1.008 }, "…"],
    "summary": [
      { "label": "Cuts", "value": "3", "tone": "coral" },
      { "label": "Saved", "value": "1.2s", "tone": "teal" }
    ],
    "focus": 16.4
  },
  "chips": ["Trim long pauses", "Add captions"]
}
```

`op` is a timeline op the editor can preview with its own engine, on the version the plan was made for. `strip` is the
before/after bar for the card. A request that needs a choice comes back with a `question` instead:

```json
{
  "text": "Happy to. Which part should the Reel come from?",
  "question": {
    "id": "q_e2c577dd",
    "intent": "reel|step=part",
    "prompt": "Which part?",
    "options": [
      {
        "id": "best",
        "label": "My best hook",
        "hint": "Toh basically, sabse pehle ek sawaal… · 73"
      },
      { "id": "here", "label": "From where I am now", "hint": "0:00" },
      { "id": "all", "label": "The whole video" }
    ]
  }
}
```

Counts against the person's daily allowance (see [`GET /me/usage`](#get-meusage)) when a model call was made for it.

### POST /projects/{id}/assistant/answers

Sends back a tapped option: `{ "question": <the question card as received>, "optionId": "best", "playhead": 0, "history": [] }`.
The card is checked: an option that is not on it, a duplicate option id, or an `intent` the assistant did not issue is `422`. The
answer is the next result: another question, or the plan.

### POST /projects/{id}/assistant/reel

Builds a Reel plan from a range, for the "Make a Reel" buttons in Clips and Search. No model is used, so this does not count
against the allowance.

```bash
curl -X POST $A/projects/$PID/assistant/reel -H "$H" -H 'content-type: application/json' \
  -d '{"srcFrom":10,"srcTo":40,"title":"Funding","fast":true,"hookScore":82}'
```

`srcFrom` and `srcTo` are seconds in the original video. A range that is backwards or outside the video is `422`. `fast`
(default `true`) also removes fillers and long pauses; `false` leaves the pace alone.

### GET /projects/{id}/plans

The Edit cards made for this project, oldest first, each a plan as above with a `status`: `proposed`, `previewing` (set by
the editor), `applied` or `undone`. A reload uses this to restore the cards. A plan's status follows the timeline: applying it
makes it `applied`, undoing that version makes it `undone`, redoing makes it `applied` again.

### POST /projects/{id}/plans/{planId}/apply

```bash
curl -X POST $A/projects/$PID/plans/$PLAN/apply -H "$H" -H 'content-type: application/json' -d '{"baseVersion":0}'
```

Applies the plan as a new timeline version by the assistant: `author` is `ai` and `editId` is the plan's id. The answer is the
same as `POST /timeline/ops`:

```json
{
  "version": {
    "id": "v_1",
    "n": 1,
    "parentN": 0,
    "author": "ai",
    "label": "3 filler words hatao",
    "editId": "01a16ef1-c3ef-7fbc-a676-db6cf5e500f5",
    "current": true,
    "onBranch": true,
    "redoable": false
  },
  "state": { "version": 1, "…": "…" }
}
```

- `baseVersion` is the version the editor is at. If the timeline has moved, this is `409 VERSION_CONFLICT` as usual.
- If the timeline changed after the plan was made, the plan is checked again against the current timeline. If it still fits it is applied. If it does not, the answer is `409 STALE_PLAN` with `details.planVersion` and `details.currentVersion`: ask the assistant again.
- A plan that is already applied is `409 CONFLICT`.

To take it back, use `POST /timeline/undo`. To undo it by committing the inverse yourself, send `undoesEditId` (the plan's id) with
the ops on `POST /timeline/ops`; the plan then reads as `undone`.

### GET /me/usage

```json
{ "plan": "free", "planner": { "used": 2, "limit": 30, "resetsAt": "2026-10-25T00:00:00.000Z" } }
```

How much of today's assistant allowance is used. The day is UTC and `resetsAt` is the next midnight. `limit` is
`PLANNER_DAILY_LIMIT` times the plan's multiplier (free 1, creator 5, studio 20). A request counts once, however many model calls
it took, and only when a real model was asked: requests the service failed, requests answered by the offline model, and
`/assistant/reel` do not count.

At the limit, `messages` and `answers` answer `429 RATE_LIMITED` with a `Retry-After` header and `details`
(`limit`, `used`, `retryAfterSec`, and `resetsAt` or `window: "minute"`). A burst limit (`PLANNER_BURST_PER_MINUTE`, default 10) applies as well.

## Style

Style teaches the assistant how a creator edits: how soon their best Reels start, how often they cut, which caption look they use, and
the fonts and colours. It is learned from the creator's **best** Reels (the best third by engagement, at least three), by
measurement: timing, cut pace, speech rate and caption look come from the video itself, and a model only labels captions the rules
could not place and writes one sentence. A profile holds numbers and style ids; it never holds anyone's content.

Reels get in by **manual upload** (this section) or, later, from Instagram. Both fill the same tables.

The videos go through the ordinary resumable upload, `POST /uploads` with `"purpose": "style_reel"` and no project, then
`/uploads/{id}/parts` and `/uploads/{id}/complete`. Finishing one answers `{ upload, reel: { id, label, durationSec } }`. A Reel can be at most
90 seconds (checked from the file, not from what the browser says), a person can have 10, and they do not use the monthly project uploads.

- `403 LIMIT_STYLE_REELS` (`details.max`): ten already; remove one with `DELETE /style/reels/{id}`.
- `403 LIMIT_REEL_LENGTH` (`details.maxSeconds`, `details.durationSec`): over 90 seconds.

A Reel that has been uploaded but not submitted is removed, with its video, after a day.

### GET /style

```bash
curl $A/style -H "$H"
```

```json
{
  "connected": true,
  "source": "upload",
  "reelsAnalysed": 3,
  "hookTimingSec": 1.5,
  "cutPace": 2.4,
  "captionStyles": [
    { "id": "saffron-pop", "share": 0.9 },
    { "id": "custom", "share": 0.1 }
  ],
  "music": [],
  "hookRetention": [],
  "fonts": ["Inter"],
  "colors": ["#fda73a", "#ffffff"],
  "confidence": "low",
  "updatedAt": "2026-10-25T09:12:41.100Z",
  "summary": "Your best Reels hook in under 2 seconds and cut every 4.2 seconds, with Saffron Pop captions."
}
```

Always a profile. A person with none gets the same shape with `"connected": false`, `"source": null`, zeros and empty lists. `cutPace` is cuts per
10 seconds. `captionStyles` shares add up to 1; an id is one of the editor's caption styles, or `custom` when captions were seen that match none.
`music` is always empty: music is not learned. `hookRetention` is empty unless Instagram supplied it. `confidence` is `low` with fewer than three
Reels or nothing to rank them by, `medium` with five Reels of which three have numbers, `high` with ten and eight. `summary` is absent when none
could be written. `handle` is present for an Instagram connection.

### GET /style/reels

The person's analysed Reels, best engagement first, then those with no score, newest first.

```json
[
  {
    "id": "01a16f…",
    "title": "best",
    "thumbSeed": "01a16f…",
    "thumbUrl": "https://…",
    "views": 9000,
    "likes": 800,
    "comments": null,
    "saves": 700,
    "shares": 500,
    "avgWatchPct": 80,
    "durationSec": 12,
    "postedAt": "2026-10-25T09:10:02.000Z",
    "engagement": 100,
    "source": "upload"
  }
]
```

A number that was not given is `null`, never 0. `engagement` (0-100) is the Reel's rank among this person's own Reels, so a small account is not
marked down for small numbers; it is `null` without enough numbers to score. `thumbUrl` is a short-lived link to the Reel's picture.

### GET /style/status

```json
{
  "state": "analysing",
  "progress": 40,
  "reels": { "total": 3, "analysed": 1, "analysing": 2, "pending": 0, "failed": 0 },
  "failed": [],
  "updatedAt": "2026-10-25T09:12:41.100Z",
  "needs": null
}
```

`state` is `idle`, `analysing`, `syncing` (reading Instagram), `ready`, `failed`, or `reauth_required` (the Instagram connection has expired: show Reconnect). `needs` is `"reel_files"` when Instagram is connected and its numbers read, but no video has been uploaded to learn the style from: a style comes from the videos themselves, so the page asks for the files of their best Reels. Poll it after `POST /style/upload` until it is `ready`,
then read `GET /style`. `failed` lists Reels that could not be analysed, each with a `code` and a `message` the person can act on (`too_long`,
`unreadable`, `no_video`, `transcription_failed`); the rest are still learned from.

### POST /style/upload

```bash
curl -X POST $A/style/upload -H "$H" -H 'content-type: application/json' \
  -d '{"count":3,"metrics":[{"reelId":"01a16f…","views":9000,"likes":800,"saves":700,"shares":500,"avgWatchPct":80},{"fileName":"second.mp4","views":8000}]}'
```

Starts learning from the Reels that have finished uploading. `count` (1-10) is how many the person means to use; if fewer have finished it is
`409 CONFLICT` with `details.uploaded` and `details.expected`, and nothing starts. `metrics` is optional: each entry names a Reel by `reelId` (from the
upload's `complete` answer) or by `fileName`, and gives any of `views`, `likes`, `comments`, `saves`, `shares` (whole numbers, 0 or more) and
`avgWatchPct` (0-100). A Reel without numbers is still learned from, for its style. Anything else, a number for a Reel that is not theirs, or two
entries for one Reel is `422`, and nothing is stored.

The answer is the profile as it is now, which for a first upload is the empty one. The learning runs in the background; follow it with `GET /style/status`.
Once a Reel has been analysed its video is deleted: only the numbers and a thumbnail are kept.

### POST /style/connect

Starts connecting Instagram (through Meta's official Instagram API with Instagram Login, read-only). The page shows `consent`, then sends the person
to `authUrl`, where they approve on Instagram's own screen.

```json
{
  "authUrl": "https://www.instagram.com/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=instagram_business_basic,instagram_business_manage_insights&state=…",
  "consent": {
    "reads": [
      "Your Reels: when they were posted, and how long ago.",
      "Their numbers: views, likes, comments, saves, shares and watch time.",
      "Your handle, to show which account is connected."
    ],
    "uses": "Lypcut works out which of your Reels did best and learns your style from them: …",
    "never": ["Post, comment, message or change anything on your Instagram.", "…"],
    "disconnect": "You can disconnect at any time on the Style page. …"
  },
  "scopes": ["instagram_business_basic", "instagram_business_manage_insights"]
}
```

The `state` in `authUrl` is random, belongs to this person, works once and lasts ten minutes; only its hash is stored. `501` when Instagram is not set up on the
server (production without a Meta app): the Style page offers manual upload only. Without a Meta app outside production, `authUrl` points at a stand-in
consent screen served by this API (below), so the whole flow can be tried.

### GET /style/callback

Where Instagram sends the browser back, with `code` and `state` (or `error` if the person cancelled). **Public**: the browser arrives from another site, so
there is no login to check; the single-use `state` is what ties it to the person, and a browser logged in as someone else is refused. Nothing is asked of Instagram until
the state has been checked and spent. It always answers `302` to the Style page, at the address in `APP_URL` (nothing in the request can change it):

| Redirect to `…/app/style?…`                   | Meaning                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `connected=1`                                 | Connected. The first read of their Reels is queued.                                                               |
| `connected=0&reason=not_professional_account` | A personal account. Nothing is stored. The page says "Switch to a Creator account, it is free" and offers upload. |
| `connected=0&reason=denied`                   | They cancelled on Instagram.                                                                                      |
| `connected=0&reason=permission_denied`        | They approved fewer permissions than the two reads.                                                               |
| `connected=0&reason=invalid_state`            | No state, a wrong, used or expired one, or someone else's. Nothing was done.                                      |
| `connected=0&reason=exchange_failed`          | Instagram refused the code.                                                                                       |
| `connected=0&reason=unavailable`              | Instagram could not be reached or is rate-limiting.                                                               |

Tokens, codes and states are never returned, and never logged (request logs hold the path only).

### POST /style/sync

Reads the connected Instagram again: `202 { "jobId": "…" }`. Once an hour per person: more than that is `429 RATE_LIMITED` with `Retry-After` and `details.retryAfterSec`.
Asking while one is running answers with that one. `409 CONFLICT` with no connected account, or when it has expired and they must connect again. Every connected account is also
read about weekly, and its token renewed well before its 60 days end; if Instagram stops accepting it, `GET /style/status` says `reauth_required` and the last good profile stays.

### GET /style/fake-instagram/authorize

Development only, and only when no Meta app is set up: a page standing in for Instagram's consent screen, with links to continue as a Creator, a Business or a personal
account, or to cancel. Absent in production.

### GET /privacy

The public privacy policy Meta requires, as a web page: what is read (and only after approval), what is not, why, where it goes, how long it is kept, and how to remove it.
The name and contact come from `LEGAL_ENTITY_NAME` and `PRIVACY_CONTACT_EMAIL`.

### POST /privacy/instagram/deletion

Meta's data-deletion callback. A form with one field, `signed_request` (`<signature>.<payload>`, HMAC-SHA256 with the app secret, compared in constant time). A request that is
not exactly that is `403` and nothing happens. Otherwise it removes, for every Lypcut account connected to that Instagram account, the connection (and so the token), every Reel read from
Instagram with its numbers, and pending sign-ins, then works the profile out again from what is left (the person's own uploaded Reels are theirs, not Instagram's). Instagram data is never
stored as files, so there is nothing in storage to remove.

```json
{
  "url": "https://api.example.com/api/privacy/instagram/deletion?code=01a17022-…",
  "confirmation_code": "01a17022-…"
}
```

An account Lypcut has never heard of also gets a code. Safe to repeat.

### GET /privacy/instagram/deletion

`?code=<confirmation_code>` answers `{ "status": "completed" }`, or `404 { "status": "unknown" }` for anything that is not a code this callback gave out.

### DELETE /style/reels/{id}

Removes one Reel, its numbers and its picture, and works the profile out again. `404` for a Reel that is not theirs, the same answer as for one that does not exist.

### DELETE /style/connect

Removes everything Style holds for the person: the Instagram connection and its token, every Reel with its numbers and analysis, the profile, pending
sign-ins, and the videos and pictures. The database rows are gone when it answers, with the empty profile; the files follow in a job that retries until
storage is clean and logs when it is. Safe to call twice. A person's projects are not touched.

## Error codes

| HTTP | `code`                  | Meaning                                                                                                                               |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 401  | `UNAUTHENTICATED`       | No valid session. Refresh, or log in again.                                                                                           |
| 401  | `INVALID_CREDENTIALS`   | Wrong email or password.                                                                                                              |
| 403  | `FORBIDDEN`             | Not allowed, or a browser write from an origin not in `CORS_ORIGINS`.                                                                 |
| 403  | `LIMIT_VIDEO_LENGTH`    | Longer than the plan allows. `details.maxSeconds`, `details.durationSec`.                                                             |
| 403  | `LIMIT_MONTHLY_UPLOADS` | Monthly uploads used up. `details.max`.                                                                                               |
| 403  | `LIMIT_STYLE_REELS`     | Ten Reels for style learning already. `details.max`.                                                                                  |
| 403  | `LIMIT_REEL_LENGTH`     | A style Reel is over 90 seconds. `details.maxSeconds`, `details.durationSec`.                                                         |
| 404  | `NOT_FOUND`             | Does not exist, or belongs to someone else.                                                                                           |
| 409  | `EMAIL_TAKEN`           | That email already has an account.                                                                                                    |
| 409  | `VERSION_CONFLICT`      | The timeline changed since `baseVersion`. `details.currentVersion`, `lastVersion`.                                                    |
| 409  | `STALE_PLAN`            | The timeline changed since the plan was made and the plan no longer fits. `details.planVersion`, `currentVersion`.                    |
| 409  | `NOT_READY`             | The project is still processing.                                                                                                      |
| 409  | `CONFLICT`              | The action does not fit the current state: nothing to undo or redo, the upload or job is already finished, restoring what is current. |
| 410  | `UPLOAD_EXPIRED`        | The 24 hours passed. Start a new upload.                                                                                              |
| 413  | `PAYLOAD_TOO_LARGE`     | The file is larger than allowed.                                                                                                      |
| 415  | `UNSUPPORTED_MEDIA`     | Not a video the service can read.                                                                                                     |
| 422  | `VALIDATION_ERROR`      | A field is wrong. `details.field` and `details.issues`.                                                                               |
| 422  | `INVALID_OP`            | The engine refused an op. `details.opIndex`, `details.opType`.                                                                        |
| 422  | `UPLOAD_INCOMPLETE`     | Parts are missing or the wrong size. `details.missing`, `details.wrongSize`.                                                          |
| 422  | `CHECKSUM_MISMATCH`     | The checksum does not match what was uploaded.                                                                                        |
| 429  | `RATE_LIMITED`          | Slow down; see `Retry-After`.                                                                                                         |
| 501  | `NOT_IMPLEMENTED`       | Not available yet (Google sign-in).                                                                                                   |
| 503  | `UNAVAILABLE`           | A dependency is down; try again.                                                                                                      |
| 500  | `INTERNAL_ERROR`        | A bug. The `x-request-id` header identifies the request in the logs.                                                                  |

Every response carries `x-request-id`; quote it when reporting a problem.
