# Lypcut

AI-native video editing for creators: edit a video by talking to it, in Hindi, Hinglish or English.

| Folder                                               | What it is                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`frontend/`](frontend/)                             | The web app (React, TypeScript, Vite). Runs on a built-in mock API or on the real backend.            |
| [`packages/timeline-core/`](packages/timeline-core/) | The timeline engine shared by both, so an edit means the same thing in the browser and on the server. |
| [`backend/`](backend/)                               | The API and workers (Node, Fastify, Postgres, Redis, S3-compatible storage, FFmpeg, Whisper).         |

## Run everything

```bash
# 1. Backend: Postgres, Redis, storage, API, worker (first run downloads a ~465 MB speech model)
cd backend && docker compose up -d

# 2. Front end against it
cd ../frontend && npm install
echo "VITE_API_MODE=real" > .env.local
npm run dev          # http://localhost:5173
```

No API key is needed: the assistant, hooks and chapters run on a built-in offline model. To use Claude, put
`ANTHROPIC_API_KEY` in `backend/.env` before `docker compose up`. A three-minute walk-through is in [`DEMO.md`](DEMO.md).

Front end only, no server: `cd frontend && npm install && npm run dev` (mock mode).

See each folder's README for details, [`backend/API.md`](backend/API.md) for the API and
[`backend/DECISIONS.md`](backend/DECISIONS.md) for the reasoning behind the design.
